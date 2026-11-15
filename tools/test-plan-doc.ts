/**
 * Regression test for the console-plan document model (extensions/lib/plan-doc.ts) — backlog #16.
 *
 * What this suite is really protecting:
 *   1. STABLE STEP IDS. Every renderer prints #id and every op addresses by id. If ids drifted
 *      with position, a user edit in /plan view and a model update would silently hit different
 *      steps — and both sides would believe they were talking about the same one.
 *   2. PURITY. applyPlanOp must never mutate its input: the overlay holds a document while the
 *      agent's plan_doc call lands underneath it. A mutation here is a lost edit, not a crash.
 *   3. THE HEIGHT BUDGET. An over-long plan must not overflow the widget/overlay (pi's renderer
 *      throws on an over-wide line — that is a TUI crash, not cosmetics).
 *   4. THE ROUND TRIP. normalizePlanDoc reads what session-state wrote; planDocFromMarkdown /
 *      planDocToMarkdown bridge the two plan modes. Anything that fails here means a resumed
 *      session quietly loses the plan it was mid-way through.
 *
 * Run: npx tsx tools/test-plan-doc.ts        Exit 0 = all pass. No terminal, no pi runtime.
 */
import {
	STATUS_CYCLE,
	applyPlanOp,
	implementationInstructionFromDoc,
	newPlanDoc,
	normalizePlanDoc,
	planDocFromMarkdown,
	planDocToMarkdown,
	planProgress,
	planSignature,
	planWidgetLines,
	renderPlanText,
	type PlanDoc,
} from "../extensions/lib/plan-doc.ts";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: string): void {
	checks++;
	if (cond) console.log(`  PASS  ${name}`);
	else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const doc = (): PlanDoc =>
	newPlanDoc({ title: "RAG overhaul", task: "fix the reranker split", steps: ["wire reranker", "hold switch-back", "pin embedder to GPU 0"] });

// ── 1. construction ───────────────────────────────────────────────────────────
void (() => {
	console.log("construction");
	const d = doc();
	check("steps are created open, ids 1..n", d.steps.length === 3 && d.steps.every((s, i) => s.status === "open" && s.id === i + 1));
	check("empty step texts are skipped", newPlanDoc({ steps: ["a", "  ", ""] }).steps.length === 1);
	check("style discriminator is always tui", d.style === "tui");
	check("progress counts the three open steps", planProgress(d).open === 3 && planProgress(d).total === 3 && !planProgress(d).allDone);
})();

// ── 2. operations ─────────────────────────────────────────────────────────────
void (() => {
	console.log("operations");
	let d = doc();
	const before = JSON.stringify(d);

	const r1 = applyPlanOp(d, { action: "status", id: 2, status: "done" });
	check("status applies", r1.ok && r1.doc.steps.find((s) => s.id === 2)!.status === "done");
	check("status leaves the other steps alone", r1.doc.steps.filter((s) => s.status === "done").length === 1);
	check("the input document is NOT mutated", JSON.stringify(d) === before, "applyPlanOp mutated its argument");
	check("revised bumps on every accepted op", r1.doc.revised === d.revised + 1);
	check("log names the step by id", r1.log.includes("#2"));
	d = r1.doc;

	check("unknown id fails with a reason", applyPlanOp(d, { action: "status", id: 99, status: "done" }).reason?.includes("#99") === true);
	check("same status twice is a no-op failure, not a silent success", applyPlanOp(d, { action: "status", id: 2, status: "done" }).ok === false);

	// id stability across add / reorder / remove — the core claim of the module.
	const r2 = applyPlanOp(d, { action: "add", text: "insert me", after: 1 });
	check("add after #1 lands at position 2", r2.ok && r2.doc.steps[1]!.text === "insert me");
	check("add gets a fresh id (never reuses)", r2.doc.steps[1]!.id === 4 && r2.doc.steps.filter((s) => s.id === 4).length === 1);
	d = r2.doc;

	const r3 = applyPlanOp(d, { action: "reorder", id: 4, after: 2 });
	check("reorder moves the step to the named position", r3.ok && r3.doc.steps[2]!.id === 4 && r3.doc.steps[1]!.id === 2, r3.doc.steps.map((s) => s.id).join(","));
	check("reorder keeps the id", r3.doc.steps.find((s) => s.id === 4)!.text === "insert me");
	check("reorder log states the new position", r3.log.includes("position 3/4"), r3.log);
	d = r3.doc;

	const r4 = applyPlanOp(d, { action: "reorder", id: 3, after: null });
	check("reorder to the top", r4.ok && r4.doc.steps[0]!.id === 3);
	check("reorder onto itself is refused", applyPlanOp(d, { action: "reorder", id: 3, after: 3 }).ok === false);
	check("reorder after a missing id is refused", applyPlanOp(d, { action: "reorder", id: 3, after: 77 }).ok === false);
	d = r4.doc;

	const idsBefore = d.steps.map((s) => s.id).join(",");
	const r5 = applyPlanOp(d, { action: "remove", id: 2 });
	check("remove takes exactly the named step", r5.ok && r5.doc.steps.length === 3 && !r5.doc.steps.some((s) => s.id === 2));
	check("removing a step renumbers nothing — the surviving ids are unchanged", r5.doc.steps.map((s) => s.id).join(",") === idsBefore.split(",").filter((x) => x !== "2").join(","));
	d = r5.doc;

	const cyc = STATUS_CYCLE.map(() => {
		const out = applyPlanOp(d, { action: "cycle", id: 1 });
		d = out.doc;
		return out.doc.steps.find((s) => s.id === 1)!.status;
	});
	check("cycle walks open→doing→done→dropped→open", cyc.join(",") === "doing,done,dropped,open", cyc.join(","));

	const r6 = applyPlanOp(d, { action: "update", id: 1, text: "renamed", note: "blocked by #14" });
	check("update rewrites text and note", r6.ok && r6.doc.steps.find((s) => s.id === 1)!.text === "renamed" && r6.doc.steps.find((s) => s.id === 1)!.note === "blocked by #14");
	check("update with neither text nor note is refused", applyPlanOp(d, { action: "update", id: 1 }).ok === false);
	d = r6.doc;

	const r7 = applyPlanOp(d, { action: "note", kind: "decision", text: "keep the file mode intact" });
	check("note lands in the right bucket", r7.ok && r7.doc.decisions.length === 1 && r7.doc.constraints.length === 0 && r7.doc.openQuestions.length === 0);
	check("duplicate note is refused", applyPlanOp(r7.doc, { action: "note", kind: "decision", text: "keep the file mode intact" }).ok === false);
	const r8 = applyPlanOp(r7.doc, { action: "unnote", kind: "decision", index: 0 });
	check("unnote removes it", r8.ok && r8.doc.decisions.length === 0);
	check("unnote out of range is refused", applyPlanOp(r7.doc, { action: "unnote", kind: "decision", index: 5 }).ok === false);

	const r9 = applyPlanOp(d, { action: "set", title: "New title", task: "new task" });
	check("set replaces the header", r9.ok && r9.doc.title === "New title" && r9.doc.task === "new task");
	check("set with the same header is a no-op failure", applyPlanOp(r9.doc, { action: "set", title: "New title", task: "new task" }).ok === false);

	const r10 = applyPlanOp(d, { action: "reset" });
	check("reset clears steps and notes but keeps title/task", r10.ok && r10.doc.steps.length === 0 && r10.doc.decisions.length === 0 && r10.doc.title === d.title && r10.doc.task === d.task);
	check("add with empty text is refused", applyPlanOp(d, { action: "add", text: "   " }).ok === false);
})();

// ── 3. progress + signature ───────────────────────────────────────────────────
void (() => {
	console.log("progress + signature");
	let d = doc();
	for (const id of [1, 3]) d = applyPlanOp(d, { action: "status", id, status: "done" }).doc;
	d = applyPlanOp(d, { action: "status", id: 2, status: "dropped" }).doc;
	const p = planProgress(d);
	check("allDone holds when only done/dropped remain", p.allDone && p.remaining.length === 0);
	check("dropped steps are counted separately from done", p.done === 2 && p.dropped === 1);

	const sigA = planSignature(d);
	const sigB = planSignature(applyPlanOp(d, { action: "status", id: 2, status: "open" }).doc);
	check("signature changes when a status changes", sigA !== sigB);
	check("signature is stable for an unchanged plan", planSignature(d) === sigA);
	check("signature of null is distinct", planSignature(null) === "none" && planSignature(null) !== sigA);
})();

// ── 4. model-facing text ──────────────────────────────────────────────────────
void (() => {
	console.log("renderPlanText");
	let d = applyPlanOp(doc(), { action: "note", kind: "constraint", text: "never load onto the 5070" }).doc;
	d = applyPlanOp(d, { action: "update", id: 1, note: "images.py" }).doc;
	const text = renderPlanText(d);
	check("every step id is printed", d.steps.every((s) => text.includes(`#${s.id} `)));
	check("step note is carried", text.includes("images.py"));
	check("constraint bucket is printed under its heading", text.includes("Constraints:") && text.includes("never load onto the 5070"));
	check("progress line is present", text.includes("0/3 steps done"));
	check("empty plan says how to add steps", renderPlanText(newPlanDoc()).includes("action=add"));
})();

// ── 5. widget lines + height budget ───────────────────────────────────────────
void (() => {
	console.log("planWidgetLines");
	const many = newPlanDoc({ title: "long plan", steps: Array.from({ length: 30 }, (_x, i) => `step number ${i + 1} with some more words so it is long enough to truncate`) });
	const termWidth = 60;
	const small = planWidgetLines(many, { width: termWidth, maxRows: 8, theme: { fg: (_c, t) => t } });
	check("rendered lines never exceed the terminal width", small.lines.every((l) => l.length <= termWidth), small.lines.find((l) => l.length > termWidth));
	check("step rows stay inside the row budget", small.lines.filter((l) => l.includes("#")).length <= 8, `${small.lines.length} lines`);
	check("hidden steps are reported in both directions", small.hiddenAbove > 0 || small.hiddenBelow > 0);

	const cursorLow = planWidgetLines(many, { width: termWidth, maxRows: 6, cursor: 29 });
	check("the hovered step is always rendered (cursor-anchored window)", cursorLow.lines.some((l) => l.includes("#30")), cursorLow.lines.join("\n"));
	check("window anchored at the end reports only 'more above'", cursorLow.hiddenBelow === 0 && cursorLow.hiddenAbove > 0);

	const one = planWidgetLines(newPlanDoc({ title: "t", steps: ["only step"] }), { width: 40, maxRows: 20 });
	check("a short plan renders its single step", one.lines.some((l) => l.includes("only step")) && one.hiddenAbove === 0 && one.hiddenBelow === 0);

	const notes = planWidgetLines(applyPlanOp(newPlanDoc({ title: "t", steps: ["s"] }), { action: "note", kind: "decision", text: "chord A" }).doc, { width: 40, maxRows: 20, notes: true });
	check("notes render when asked", notes.lines.some((l) => l.includes("Decisions")) && notes.lines.some((l) => l.includes("chord A")));
	const noNotes = planWidgetLines(applyPlanOp(newPlanDoc({ title: "t", steps: ["s"] }), { action: "note", kind: "decision", text: "chord A" }).doc, { width: 40, maxRows: 20, notes: false });
	check("notes stay out when not asked", !noNotes.lines.some((l) => l.includes("Decisions")));

	const narrow = planWidgetLines(newPlanDoc({ title: "a very long plan title that will not fit", steps: ["a very long step text that will not fit either"] }), { width: 22, maxRows: 6 });
	check("narrow terminals truncate instead of overflowing", narrow.lines.every((l) => l.length <= 22), narrow.lines.join("\n"));

	const ids = newPlanDoc({ steps: ["a", "b"] });
	const big = applyPlanOp(applyPlanOp(ids, { action: "remove", id: 1 }).doc, { action: "add", text: "new" }).doc;
	const bigLines = planWidgetLines(big, { width: 60, maxRows: 10 });
	check("id column width follows the largest id", bigLines.lines.some((l) => l.includes("#2")) && bigLines.lines.some((l) => l.includes("#3")), bigLines.lines.join("\n"));
})();

// ── 6. disk round trip ────────────────────────────────────────────────────────
void (() => {
	console.log("normalizePlanDoc (disk round trip)");
	let d = doc();
	d = applyPlanOp(d, { action: "status", id: 1, status: "doing" }).doc;
	d = applyPlanOp(d, { action: "update", id: 2, note: "note survives" }).doc;
	d = applyPlanOp(d, { action: "note", kind: "open", text: "which card?" }).doc;
	const round = normalizePlanDoc(JSON.parse(JSON.stringify(d)));
	check("round trip preserves steps, ids, statuses and notes", !!round && JSON.stringify(round.steps) === JSON.stringify(d.steps));
	check("round trip preserves the note buckets", !!round && round.openQuestions.length === 1 && round.decisions.length === 0);
	check("round trip preserves title/task/revised", !!round && round.title === d.title && round.task === d.task && round.revised === d.revised);

	check("null is not a plan", normalizePlanDoc(null) === null);
	check("a file-mode document is not a console plan", normalizePlanDoc({ style: "file", steps: [] }) === null);
	check("garbage is not a plan", normalizePlanDoc("{ not json") === null);

	const patched = normalizePlanDoc({ style: "tui", title: "t", steps: [{ text: "no id, no status" }, { id: 5, text: "id 5", status: "bogus" }, { id: 5, text: "duplicate id" }, { text: "" }] });
	check("steps without an id get one", !!patched && patched.steps.length === 3);
	check("a duplicate id is re-keyed instead of colliding", !!patched && new Set(patched.steps.map((s) => s.id)).size === patched.steps.length);
	check("an unknown status falls back to open", !!patched && patched.steps.every((s) => STATUS_CYCLE.includes(s.status)));
	check("nextId is ahead of every id after re-keying", !!patched && patched.nextId > Math.max(...patched.steps.map((s) => s.id)));
})();

// ── 7. approval handoff ───────────────────────────────────────────────────────
void (() => {
	console.log("implementationInstructionFromDoc");
	let d = applyPlanOp(doc(), { action: "status", id: 1, status: "done" }).doc;
	d = applyPlanOp(d, { action: "status", id: 3, status: "dropped" }).doc;
	d = applyPlanOp(d, { action: "note", kind: "decision", text: "docker only" }).doc;
	const ins = implementationInstructionFromDoc(d);
	check("says APPROVED and names the plan", ins.includes("PLAN APPROVED") && ins.includes("RAG overhaul"));
	check("lists every step with its status", d.steps.every((s) => ins.includes(`#${s.id} [${s.status}]`)));
	check("carries the decisions the implementation must honor", ins.includes("docker only"));
	check("counts what remains (1 of 3)", ins.includes("1 step(s) remain") && ins.includes("1 already done"));
	check("tells the model to mark steps as it goes", ins.includes("plan_doc action=status"));
	check("dropped steps are protected from being re-opened", ins.includes("do not re-open a dropped step"));
})();

// ── 8. markdown bridge ────────────────────────────────────────────────────────
void (() => {
	console.log("markdown import/export");
	const md = [
		"# RAG overhaul",
		"",
		"## Approach",
		"1. wire the reranker",
		"2. hold the switch-back",
		"- [x] already finished step",
		"",
		"## Decisions",
		"- keep file mode intact",
		"",
		"## Open questions",
		"- which GPU owns the embedder",
	].join("\n");
	const d = planDocFromMarkdown(md, { task: "from a .md plan" });
	check("title comes from the first heading", d.title === "RAG overhaul");
	check("numbered and checkbox steps both become steps", d.steps.length === 3, d.steps.map((s) => s.text).join(" / "));
	check("a checked step imports as done", d.steps.some((s) => s.text === "already finished step" && s.status === "done"));
	check("the Approach heading does not become a constraint", d.constraints.length === 0, d.constraints.join(" / "));
	check("Decisions / Open questions buckets import", d.decisions.length === 1 && d.openQuestions.length === 1);
	check("imported ids are unique", new Set(d.steps.map((s) => s.id)).size === d.steps.length);

	const back = planDocToMarkdown(d);
	const again = planDocFromMarkdown(back);
	check("export→import round trip keeps the step count", again.steps.length === d.steps.length);
	check("export→import keeps done-ness", again.steps.filter((s) => s.status === "done").length === d.steps.filter((s) => s.status === "done").length);
	check("export carries the notes", back.includes("## Decisions") && back.includes("keep file mode intact"));
})();

console.log("");
if (failures > 0) { console.error(`${failures} of ${checks} CHECK(S) FAILED`); process.exit(1); }
console.log(`ALL PASS (${checks} checks)`);
