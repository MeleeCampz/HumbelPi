/**
 * Regression test for the CONSOLE plan-mode overlay editor (backlog #16): real keystrokes driven
 * into createPlanEditor against a fake host whose document is edited by the REAL plan-doc operations
 * (so stable ids, reorders, two-step deletes and note indexes behave exactly as they do in the app),
 * plus the height/width budgets pi's renderer insists on.
 *
 * Run: npx -y tsx tools/test-plan-view.ts
 */
import { applyPlanOp, newPlanDoc, type PlanDoc, type PlanOp } from "../extensions/lib/plan-doc";
import { createPlanEditor, planPlainLines, type PlanEditorClose } from "../extensions/lib/plan-view";

const theme = { fg: (_c: string, t: string) => t };
const strip = (s: string) => s.replace(/\u001b[^\n]*?m/g, "");

let failures = 0;
let checks = 0;
function check(name: string, cond: unknown, detail?: string): void {
	checks++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? ` — ${detail}` : ""}`);
	if (!cond) failures++;
}

// Small terminal on purpose: the overlay must fit it (backlog #5 lesson).
Object.defineProperty(process.stdout, "rows", { value: 14, configurable: true });
const ROWS = 14;
const WIDTH = 70;

const KEYS = {
	up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C",
	enter: "\r", esc: "\x1b", tab: "\t", pgup: "\x1b[5~", pgdn: "\x1b[6~",
};
const type = (s: string) => `\x1b[200~${s}\x1b[201~`; // bracketed paste = the real paste path

interface Fake {
	doc: PlanDoc | null;
	ops: PlanOp[];
	logs: string[];
	close: PlanEditorClose | null;
}

function fresh(doc: PlanDoc | null = newPlanDoc({ title: "Test plan", task: "the request" })) {
	const f: Fake = { doc, ops: [], logs: [], close: null };
	const c = createPlanEditor(
		{
			getDoc: () => f.doc,
			apply: (op) => {
				const res = applyPlanOp(f.doc ?? newPlanDoc(), op);
				f.ops.push(op);
				f.logs.push(res.ok ? res.log : `✗ ${res.log}`);
				if (res.ok) f.doc = res.doc;
				return res;
			},
		},
		theme,
		(r) => { f.close = r; },
	);
	const lines = () => c.render(WIDTH);
	const text = () => lines().map(strip);
	return { c, f, lines, text };
}

// ── 1. empty plan: renders, fits, and `a` adds the first step ──
{
	const { c, f, text } = fresh(newPlanDoc({ title: "Empty" }));
	let l = text();
	check("empty plan fits the terminal", l.length <= ROWS, `got ${l.length}`);
	check("empty plan says how to add", l.some((x) => x.includes("no steps yet")), JSON.stringify(l.slice(0, 6)));
	check("empty plan shows the key hints", l.some((x) => x.includes("Tab section")));
	c.handleInput("a");
	c.handleInput(type("write the parser"));
	c.handleInput(KEYS.enter);
	check("add committed one op", f.ops.length === 1 && f.ops[0]!.action === "add", JSON.stringify(f.ops));
	check("new step is #1 with the typed text", f.doc?.steps[0]?.id === 1 && f.doc?.steps[0]?.text === "write the parser", JSON.stringify(f.doc?.steps));
	l = text();
	check("added step visible in the list", l.some((x) => x.includes("#1") && x.includes("write the parser")), JSON.stringify(l));
	check("commit line reports what happened", l.some((x) => x.includes("added step #1")), JSON.stringify(l.slice(-2)));
	check("still fits after adding", l.length <= ROWS, `got ${l.length}`);
}

// ── 2. navigation: j/k move the cursor, pgup/pgdn jump 5, clamping at both ends ──
{
	let d = newPlanDoc({ title: "N" });
	for (const t of ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	const { c, text } = fresh(d);
	const hovered = (): string | undefined => text().find((x) => x.includes("❯"));
	check("cursor starts on the first step", hovered()?.includes("s1"), hovered());
	c.handleInput(KEYS.down);
	c.handleInput(KEYS.down);
	check("two downs land on #3", hovered()?.includes("#3") && hovered()?.includes("s3"), hovered());
	c.handleInput("k");
	check("'k' moves up", hovered()?.includes("#2"), hovered());
	c.handleInput(KEYS.pgup);
	check("pageUp jumps to the top", hovered()?.includes("#1"), hovered());
	c.handleInput(KEYS.pgdn);
	c.handleInput(KEYS.pgdn);
	c.handleInput(KEYS.pgdn);
	check("pageDown clamps at the last step", hovered()?.includes("#7") && hovered()?.includes("s7"), hovered());
	c.handleInput(KEYS.down);
	check("down at the end does not run off", hovered()?.includes("#7"), hovered());
}

// ── 3. status cycling (x) and the two-step delete (D, then D) ──
{
	let d = newPlanDoc({ title: "S" });
	for (const t of ["a", "b", "c"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	const { c, f, text } = fresh(d);
	c.handleInput(KEYS.down);
	c.handleInput("x");
	check("x cycles the hovered step to doing", f.doc?.steps[1]?.status === "doing", JSON.stringify(f.doc?.steps[1]));
	check("doing step is rendered with its glyph", text().some((x) => x.includes("◐") && x.includes("#2")), JSON.stringify(text()));
	c.handleInput("D");
	check("first D DROPS (does not remove)", f.doc?.steps[1]?.status === "dropped" && f.doc?.steps.length === 3, JSON.stringify(f.doc?.steps.map((s) => s.status)));
	c.handleInput("D");
	check("second D removes it", f.ops[f.ops.length - 1]?.action === "remove" && !f.doc?.steps.some((s) => s.id === 2), JSON.stringify(f.doc?.steps.map((s) => s.id)));
	check("removing keeps the other ids stable", JSON.stringify(f.doc?.steps.map((s) => s.id)) === "[1,3]", JSON.stringify(f.doc?.steps.map((s) => s.id)));
	check("cursor healed onto a live step after removal", text().some((x) => x.includes("❯") && (x.includes("#1") || x.includes("#3"))), JSON.stringify(text()));
}

// ── 4. reorder with [ and ] (order changes, ids do not) ──
{
	let d = newPlanDoc({ title: "R" });
	for (const t of ["one", "two", "three"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	const { c, f } = fresh(d);
	c.handleInput(KEYS.down); // on #2
	c.handleInput("]");
	check("] moves the hovered step down one", f.doc?.steps.map((s) => s.text).join(",") === "one,three,two", JSON.stringify(f.doc?.steps.map((s) => `${s.id}:${s.text}`)));
	check("ids stay attached to their step", f.doc?.steps.map((s) => s.id).join(",") === "1,3,2", JSON.stringify(f.doc?.steps.map((s) => `${s.id}:${s.text}`)));
	c.handleInput(KEYS.up);
	c.handleInput(KEYS.up);
	c.handleInput(KEYS.up); // cursor back at the top after the moves
	c.handleInput("[");
	check("[ at the top does nothing", f.ops.filter((o) => o.action === "reorder").length === 1, JSON.stringify(f.ops));
}

// ── 5. editing an existing step (e → text → ⏎) and cancelling with esc ──
{
	let d = newPlanDoc({ title: "E" });
	d = applyPlanOp(d, { action: "add", text: "keep this step" }).doc;
	const { c, f, text } = fresh(d);
	c.handleInput("e");
	check("e opens an input box prefilled with the step text", text().some((x) => x.includes("›") && x.includes("keep this step")), JSON.stringify(text()));
	c.handleInput(type(" (reworded)"));
	c.handleInput(KEYS.enter);
	check("enter commits an update op (not an add)", f.ops.length === 1 && f.ops[0]!.action === "update" && f.ops[0]!.id === 1, JSON.stringify(f.ops));
	check("the caret sits at the end, so typing appends to the row (editor semantics)", f.doc?.steps[0]?.text === "keep this step (reworded)", f.doc?.steps[0]?.text);
	c.handleInput("e");
	for (let i = 0; i < 40; i++) c.handleInput("\x7f"); // backspace clears the prefilled row…
	c.handleInput(type("brand new step text"));
	c.handleInput(KEYS.enter);
	check("backspace-then-type rewrites the row completely", f.doc?.steps[0]?.text === "brand new step text", f.doc?.steps[0]?.text);
	const opsBeforeCancel = f.ops.length;
	c.handleInput("e");
	c.handleInput(type("throw this away"));
	c.handleInput(KEYS.esc);
	check("esc inside an edit cancels it (no new op)", f.ops.length === opsBeforeCancel, JSON.stringify(f.ops));
	check("cancelled edit left the plan untouched", !f.doc?.steps.some((s) => s.text.includes("throw")), JSON.stringify(f.doc?.steps));
	check("cancel is reported in the commit line", text().some((x) => x.includes("edit cancelled")), JSON.stringify(text().slice(-2)));
}

// ── 6. sections: Tab cycles, n adds a note, D unnotes, e edits in place ──
{
	let d = newPlanDoc({ title: "T" });
	d = applyPlanOp(d, { action: "add", text: "a step" }).doc;
	d = applyPlanOp(d, { action: "note", kind: "decision", text: "use SQLite" }).doc;
	const { c, f, text } = fresh(d);
	c.handleInput(KEYS.tab); // steps → decisions
	check("Tab shows the Decisions list", text().some((x) => x.includes("❯ 1. use SQLite")), JSON.stringify(text()));
	c.handleInput("n");
	c.handleInput(type("pick a theme"));
	c.handleInput(KEYS.enter);
	check("n adds a note in the current section", f.doc?.decisions.length === 2 && f.doc?.decisions[1] === "pick a theme", JSON.stringify(f.doc?.decisions));
	c.handleInput(KEYS.tab); // → constraints
	check("an empty section says how to fill it", text().some((x) => x.includes("no constraints yet")), JSON.stringify(text()));
	c.handleInput(KEYS.tab); // → open questions
	check("open questions section is reachable", text().some((x) => x.includes("no open questions yet")), JSON.stringify(text()));
	c.handleInput(KEYS.tab); // → steps (wrap)
	check("Tab wraps back to the steps list", text().some((x) => x.includes("❯") && x.includes("a step")), JSON.stringify(text()));
	c.handleInput(KEYS.tab); // → decisions again
	c.handleInput(KEYS.up);
	c.handleInput("e");
	for (let i = 0; i < 40; i++) c.handleInput("\x7f");
	c.handleInput(type("use SQLite (decided)"));
	c.handleInput(KEYS.enter);
	check("e rewrites a note in place (editNote)", f.ops.some((o) => o.action === "editNote" && o.index === 0) && f.doc?.decisions[0] === "use SQLite (decided)", JSON.stringify(f.doc?.decisions));
	check("editNote did not append (list length unchanged)", f.doc?.decisions.length === 2, JSON.stringify(f.doc?.decisions));
	c.handleInput("D");
	check("D removes the hovered note", f.ops.some((o) => o.action === "unnote" && o.index === 0) && f.doc?.decisions.length === 1, JSON.stringify(f.doc?.decisions));
}

// ── 7. concurrent model edits: the cursor is a STEP ID, not a position ──
{
	let d = newPlanDoc({ title: "C" });
	for (const t of ["alpha", "beta", "gamma"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	const { c, f, text } = fresh(d);
	c.handleInput(KEYS.down); // hover #2 "beta"
	// The agent lands plan_doc calls while the overlay is open: remove #1, add #4, reorder #3.
	d = applyPlanOp(d, { action: "remove", id: 1 }).doc;
	d = applyPlanOp(d, { action: "add", text: "delta" }).doc;
	d = applyPlanOp(d, { action: "reorder", id: 4, after: 2 }).doc;
	f.doc = d;
	check("cursor stayed on #2 after the plan moved under it", text().some((x) => x.includes("❯") && x.includes("beta")), JSON.stringify(text()));
	c.handleInput("x");
	check("the edit hit the step the user was pointing at", f.doc?.steps.find((s) => s.id === 2)?.status === "doing", JSON.stringify(f.doc?.steps));
	// The hovered step is removed by the agent: the cursor must not apply an op to a dead id.
	f.doc = applyPlanOp(f.doc!, { action: "remove", id: 2 }).doc;
	c.handleInput("x");
	const lastOp = f.ops[f.ops.length - 1]!;
	check("op after a vanished step targets a live id", lastOp.action === "cycle" && f.doc!.steps.some((s) => s.id === lastOp.id), JSON.stringify({ lastOp, ids: f.doc!.steps.map((s) => s.id) }));
}

// ── 8. a host that refuses an edit is shown, not swallowed ──
{
	const doc = applyPlanOp(newPlanDoc({ title: "F" }), { action: "add", text: "only step" }).doc;
	let closed: PlanEditorClose | null = null;
	const closedOf = (): PlanEditorClose | null => closed as PlanEditorClose | null;
	const notices: string[] = [];
	const c = createPlanEditor(
		{
			getDoc: () => doc,
			apply: (op) => ({ ok: false, doc, log: `state write failed for ${op.action}`, reason: "read-only state file" }),
			notify: (m) => notices.push(m),
		},
		theme,
		(r) => { closed = r; },
	);
	c.handleInput("x");
	const l = c.render(WIDTH).map(strip);
	check("a refused edit shows a ✗ line", l.some((x) => x.startsWith("✗")), JSON.stringify(l.slice(-2)));
	check("a refused edit tells the user why", notices.some((n) => n.includes("Plan edit refused") && n.includes("state write failed for cycle")), JSON.stringify(notices));
	c.handleInput(KEYS.esc);
	check("closing after a refused edit reports 0 edits", closedOf()?.edits === 0, JSON.stringify(closedOf()));
}

// ── 9. long plans: height budget, scroll indicators, hints always visible ──
{
	let d = newPlanDoc({ title: "L" });
	for (let i = 0; i < 60; i++) d = applyPlanOp(d, { action: "add", text: `step number ${i + 1} with a bit of filler text to make rows longer` }).doc;
	const { c, text } = fresh(d);
	const l = text();
	check("60 steps fit the 14-row terminal", l.length <= ROWS, `got ${l.length}`);
	check("the hovered first step is visible", l.some((x) => x.includes("❯ #1 ")), JSON.stringify(l));
	check("the last step is scrolled away", !l.some((x) => x.includes("#60 ")), "visible");
	check("'more below' indicator", l.some((x) => x.includes("more below")), JSON.stringify(l));
	check("key hints still visible", l.some((x) => x.includes("Tab section")), JSON.stringify(l));
	for (let i = 0; i < 13; i++) c.handleInput(KEYS.pgdn); // jump past the end → clamps to #60
	const l2 = text();
	check("after jumping to the end: still fits", l2.length <= ROWS, `got ${l2.length}`);
	check("after jumping to the end: last step visible", l2.some((x) => x.includes("❯ #60 ")), JSON.stringify(l2));
	check("after jumping to the end: 'more above' indicator", l2.some((x) => x.includes("more above")), JSON.stringify(l2));
	check("after jumping to the end: no 'more below'", !l2.some((x) => x.includes("more below")), JSON.stringify(l2));
	c.handleInput(KEYS.pgup);
	const l3 = text();
	check("scrolled back into the middle: both indicators, still fits", l3.length <= ROWS && l3.some((x) => x.includes("more above")) && l3.some((x) => x.includes("more below")), `len ${l3.length}`);
}

// ── 10. width safety: a monster line must never exceed the terminal ──
{
	let d = newPlanDoc({ title: "W" });
	d = applyPlanOp(d, { action: "add", text: "x".repeat(400) }).doc;
	d = applyPlanOp(d, { action: "note", kind: "constraint", text: "y".repeat(300) }).doc;
	const a = fresh(d); // steps section: the monster step must be truncated
	check("steps section truncates the monster step", a.text().every((x) => x.length <= WIDTH), JSON.stringify(a.text().map((x) => x.length)));
	const b = fresh(d);
	b.c.handleInput(KEYS.tab); // steps → decisions
	b.c.handleInput(KEYS.tab); // → constraints (the wrapped note lives here)
	const lb = b.text();
	check("notes wrap instead of overflowing", lb.every((x) => x.length <= WIDTH), JSON.stringify(lb.map((x) => x.length)));
	check("wrapped note keeps its rows counted in the fit", lb.length <= ROWS, `got ${lb.length}`);
}

// ── 11. closing: edits are reported, a look-only visit is not a change ──
{
	let d = newPlanDoc({ title: "Q" });
	d = applyPlanOp(d, { action: "add", text: "one" }).doc;
	const a = fresh(d);
	a.c.handleInput("x");
	a.c.handleInput(KEYS.esc);
	check("esc closes the overlay with the edits listed", a.f.close?.edits === 1 && a.f.close.summary[0]?.includes("#1"), JSON.stringify(a.f.close));
	const b = fresh(d);
	b.c.handleInput(KEYS.down);
	b.c.handleInput(KEYS.esc);
	check("browsing then esc reports 0 edits", b.f.close?.edits === 0, JSON.stringify(b.f.close));
	const cCase = fresh(d);
	cCase.c.handleInput("a");
	cCase.c.handleInput(type("queued before exit"));
	cCase.c.handleInput(KEYS.esc); // esc while a draft is open cancels the draft, closing needs a second esc
	check("esc while drafting cancels the draft (no op)", cCase.f.ops.length === 0 && cCase.f.close === null, JSON.stringify(cCase.f.ops));
	cCase.c.handleInput(KEYS.esc);
	check("second esc closes with the cancelled draft unreported", cCase.f.close?.edits === 0, JSON.stringify(cCase.f.close));
}

// ── 12. an unknown letter explains the keys instead of doing nothing silently ──
{
	const { c, text } = fresh();
	c.handleInput("q");
	check("unknown keypress shows the key guide", text().some((x) => x.startsWith("✗ q does nothing")), JSON.stringify(text().slice(-2)));
}

// ── 13. the non-TUI renderer (print / rpc modes) shows the same document ──
{
	let d = newPlanDoc({ title: "Plain", task: "read it without a TUI" });
	d = applyPlanOp(d, { action: "add", text: "first step" }).doc;
	d = applyPlanOp(d, { action: "status", id: 1, status: "done" }).doc;
	d = applyPlanOp(d, { action: "note", kind: "open", text: "which theme?" }).doc;
	const l = planPlainLines(d);
	check("plain render lists the step with its status", l.some((x) => x.includes("#1") && x.includes("first step") && x.includes("✓")), JSON.stringify(l));
	check("plain render lists open questions", l.some((x) => x === "open questions:") && l.some((x) => x.includes("which theme?")), JSON.stringify(l));
	check("plain render reports progress", l[0]!.includes("1/1 done"), l[0]);
	check("plain render of no plan says so", planPlainLines(null)[0] === "(no console plan)", JSON.stringify(planPlainLines(null)));
}

console.log(failures === 0 ? `ALL PASS (${checks} checks)` : `\n${failures} of ${checks} FAILED`);
process.exit(failures === 0 ? 0 : 1);
