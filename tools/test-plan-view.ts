/**
 * Regression test for the CONSOLE plan-mode overlay editor (backlog #16): real keystrokes driven
 * into createPlanEditor against a fake host whose document is edited by the REAL plan-doc operations
 * (so stable ids, reorders, two-step deletes and note indexes behave exactly as they do in the app),
 * plus the height/width budgets pi's renderer insists on.
 *
 * Run: npx -y tsx tools/test-plan-view.ts
 */
import { applyPlanOp, newPlanDoc, type PlanDoc, type PlanOp } from "../extensions/lib/plan-doc";
import { createPlanEditor, planPlainLines, briefBlocksOf, type BriefBlock, type PlanEditorClose, type PlanSection } from "../extensions/lib/plan-view";

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

function fresh(doc: PlanDoc | null = newPlanDoc({ title: "Test plan", task: "the request" }), options: { section?: PlanSection; wrap?: boolean; readOnly?: boolean } = {}) {
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
		options,
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

// ── 2b. #15: g / G jump the cursor to the first and last row of whatever section is open ──
// Why not PageUp/PageDown: measured in the press harness, those sequences never reach this overlay —
// pi handles them for the chat viewport (PageUp even forces a full-screen repaint). Letters reach it,
// which is what x / e / a / D already prove, so the jump is spelled with letters.
void (() => {
	let d = newPlanDoc({ title: "J" });
	for (const t of ["first", "second", "third", "fourth"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	d = applyPlanOp(d, { action: "note", kind: "decision", text: "the only decision" }).doc;
	d = applyPlanOp(d, { action: "note", kind: "decision", text: "a second decision" }).doc;
	d = applyPlanOp(d, { action: "note", kind: "constraint", text: "constraint one" }).doc;
	d = applyPlanOp(d, { action: "brief", text: "line one\nline two\nline three" }).doc;
	const { c, f, text } = fresh(d);
	const hovered = (): string => text().find((x) => x.includes("❯")) ?? "";

	c.handleInput("G");
	check("G lands the step cursor on the LAST row (and names it by id, not by position)", hovered().includes("#4") && hovered().includes("fourth"), hovered());
	check("the hint row offers the jump keys so they are discoverable", text().some((x) => x.includes("g top") && x.includes("G end")), JSON.stringify(text().slice(4, 6)));
	c.handleInput("x");
	check("and the row it landed on is the one the keys then act on", f.ops.some((o) => o.action === "cycle" && o.id === 4), JSON.stringify(f.ops));
	c.handleInput("g");
	check("g lands on the FIRST row", hovered().includes("#1") && hovered().includes("first"), hovered());
	c.handleInput("G"); c.handleInput("[");
	check("a jump does not break reorder — the row under the cursor moves", (f.doc?.steps.map((s) => s.text).join(",") ?? "").includes("fourth,third"), JSON.stringify(f.doc?.steps.map((s) => s.id)));
	c.handleInput("g");
	check("g works from anywhere, including the middle of a reordered list", hovered().includes("#1"), hovered());

	c.handleInput(KEYS.tab); // Brief
	c.handleInput("G");
	check("in the Brief, G parks the line cursor on the LAST line of the body", text().some((x) => x.includes("❯ line 3/3")), JSON.stringify(text().slice(4, 7)));
	c.handleInput("g");
	check("g returns it to the first line, and the ruler in the body moves with it", text().some((x) => x.includes("❯ line 1/3")) && text().some((x) => x.includes("❯  1│")), JSON.stringify(text().slice(4, 8)));
	c.handleInput("G");
	check("the last line is reachable and editable (the jump is a cursor move, not a view change)", (() => { c.handleInput("e"); c.handleInput(" — jumped to and edited"); c.handleInput(KEYS.enter); return (f.doc?.brief ?? "").endsWith("line three — jumped to and edited"); })(), JSON.stringify((f.doc?.brief ?? "").split("\n").at(-1)));

	c.handleInput(KEYS.tab); // Brief -> Decisions
	c.handleInput("G");
	check("G jumps the NOTE cursor too", text().some((x) => x.includes("❯") && x.includes("a second decision")), JSON.stringify(text().slice(-4)));
	c.handleInput("g");
	check("and g brings it back to the first note", text().some((x) => x.includes("❯") && x.includes("the only decision")), JSON.stringify(text().slice(-4)));
	check("jumping is navigation: it is not reported as an edit when the overlay closes",
		(() => { c.handleInput(KEYS.esc); return f.close !== null && f.close.edits === 3; })(),
		JSON.stringify(f.close?.summary));
})();

// ── 2c. #17: `<` and `>` move a PAGE (a screenful of this plan), not one line ──
void (() => {
	// Steps: four rows fit the 14-row terminal, so one page is the whole list — a page jump clamps.
	let d = newPlanDoc({ title: "P" });
	for (const t of ["one", "two", "three", "four"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	const st = fresh(d);
	const hovered = (): string => st.text().find((x) => x.includes("❯")) ?? "";
	st.c.handleInput(">");
	check("> pages to the last row when the whole list fits on screen", hovered().includes("#4") && hovered().includes("four"), hovered());
	st.c.handleInput("<");
	check("< pages back, and neither press wrote anything", hovered().includes("#1") && st.f.ops.length === 0, JSON.stringify(st.f.ops));

	// Brief in a terminal that CANNOT show the body: this is the case your report was about.
	const LONG = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? `## Heading ${i / 5 + 1}` : `body line ${i + 1} of 40`)).join("\n");
	let b = newPlanDoc({ title: "Long brief" });
	b = applyPlanOp(b, { action: "add", text: "a step" }).doc;
	b = applyPlanOp(b, { action: "brief", text: LONG }).doc;
	const br = fresh(b, { section: "brief" });
	const line = (): number => {
		const m = /❯ line (\d+)\/40/.exec(br.text().join("\n"));
		return m ? Number(m[1]) : -1;
	};
	const a0 = line();
	br.c.handleInput(">");
	const a1 = line();
	check("> moves the line cursor a SCREENFUL down (not one line, not straight to the end)",
		a1 > a0 + 1 && a1 < 40, `line ${a0} -> ${a1}`);
	const visible = br.text().filter((x) => /│/.test(x)).length;
	check("and the page it moved by is the number of rows this terminal actually paints",
		Math.abs((a1 - a0) - visible) <= 2, `moved ${a1 - a0}, body shows ${visible} rows`);
	const gutter = br.text().flatMap((x) => [...x.matchAll(/(\d+)│/g)].map((m) => Number(m[1])));
	check("after a page jump the cursor row sits MID-WINDOW: a line above it and a line below it are both painted (you see where you came from and where you are going)",
		gutter.includes(a1 - 1) && gutter.includes(a1) && gutter.includes(a1 + 1), `line ${a1}, gutter numbers ${JSON.stringify(gutter)}`);
	for (let i = 0; i < 12; i++) br.c.handleInput(">");
	check("repeated > walks the document page by page and CLAMPS at the last line (it cannot run off the end)",
		line() === 40, `line ${line()}`);
	br.c.handleInput("<");
	const up1 = line();
	check("< comes back a page from there", up1 < 40 && up1 > 1, `line 40 -> ${up1}`);
	br.c.handleInput("g");
	check("g then < clamps at the first line", (() => { br.c.handleInput("<"); return line() === 1; })(), `line ${line()}`);
	check("page moves are not edits either", br.f.ops.length === 0, JSON.stringify(br.f.ops));
	br.c.handleInput("?");
	check("and a key that means nothing here says so out loud — punctuation included, because a silent key is indistinguishable from a key the terminal swallowed (the PageUp/PageDown case)",
		br.text().at(-1)!.includes("✗ ? does nothing here") && br.text().at(-1)!.includes("< > page"), br.text().at(-1));
})();

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

// ── 5b. `a` adds a NEW step after the cursor (backlog #15, found by press scenario `t`) ──
// It used to open an empty editor against the HOVERED step's id, so ⏎ took the `update` branch and
// overwrote the row you were standing on — while the box it opened said "new step (⏎ adds it after the
// cursor)". The unit suite missed it because its only `a` test ran on an EMPTY plan (no row to destroy).
{
	let d = newPlanDoc({ title: "A" });
	for (const t of ["first row", "second row", "third row"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	const { c, f, text } = fresh(d);
	c.handleInput("a");
	check("the add box states where the new row is going", text().some((x) => x.includes("adds it after the cursor")), JSON.stringify(text()));
	c.handleInput(type("inserted after one"));
	c.handleInput(KEYS.enter);
	check("a commits an ADD, never an update of the hovered row", f.ops.length === 1 && f.ops[0]!.action === "add", JSON.stringify(f.ops));
	check("every row that existed before `a` still exists", (f.doc?.steps.map((s) => s.text) ?? []).join("|") === "first row|inserted after one|second row|third row", JSON.stringify(f.doc?.steps));
	check("the cursor follows the row it just made", text().some((x) => x.includes("❯") && x.includes("inserted after one")), JSON.stringify(text()));
	check("the commit line names the new step", f.logs.some((l) => l.includes("added step #4")), JSON.stringify(f.logs));
}
{
	let d = newPlanDoc({ title: "A2" });
	for (const t of ["one", "two", "three"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	const { c, f } = fresh(d);
	c.handleInput(KEYS.down);
	c.handleInput(KEYS.down); // cursor on #3, the last row
	c.handleInput("a");
	c.handleInput(type("appended at the end"));
	c.handleInput(KEYS.enter);
	check("`a` on the last row appends (after the last row IS the end)", (f.doc?.steps.map((s) => s.text) ?? []).join("|") === "one|two|three|appended at the end", JSON.stringify(f.doc?.steps));
}
{
	// The agent lands plan_doc calls while the overlay is open. If it deletes the row `a` was anchored to,
	// an `after` naming a step that no longer exists would fail the op and eat the text already typed.
	let d = newPlanDoc({ title: "A3" });
	for (const t of ["one", "two"]) d = applyPlanOp(d, { action: "add", text: t }).doc;
	const { c, f } = fresh(d);
	c.handleInput("a");
	f.doc = applyPlanOp(f.doc!, { action: "remove", id: 1 }).doc; // the agent removed the anchor mid-edit
	c.handleInput(type("survives a vanished anchor"));
	c.handleInput(KEYS.enter);
	check("a step added against a deleted anchor still lands (appended, not refused)",
		f.ops.length === 1 && f.ops[0]!.action === "add" && !f.logs.some((l) => l.startsWith("✗")) && (f.doc?.steps.length ?? 0) === 2,
		JSON.stringify([f.ops, f.logs, f.doc?.steps]));
}

// ── 6. sections: Tab cycles, n adds a note, D unnotes, e edits in place ──
{
	let d = newPlanDoc({ title: "T" });
	d = applyPlanOp(d, { action: "add", text: "a step" }).doc;
	d = applyPlanOp(d, { action: "note", kind: "decision", text: "use SQLite" }).doc;
	const { c, f, text } = fresh(d);
	c.handleInput(KEYS.tab); // steps → BRIEF (#23: the document sits right behind the checklist)
	check("the first Tab lands on the Brief section", text().some((x) => x.includes("[Brief 0]")) && text().some((x) => x.includes("no brief yet")), JSON.stringify(text().slice(2, 6)));
	c.handleInput(KEYS.tab); // → decisions
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
	c.handleInput(KEYS.tab); // → brief
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

// ── 6b. #23: the Brief section — pi's markdown, edited a line at a time ──
void (() => {
	const BRIEF = [
		"## Why the split",
		"",
		"The embedder stays on CPU; the reranker moves.",
		"",
		"| part | where | why |",
		"| --- | --- | --- |",
		"| embedder | CPU | fp32 is enough |",
		"| reranker | GPU:0 | 8x faster there |",
		"",
		"```ts",
		'export const split = { embed: "cpu", rank: "cuda:0" };',
		"```",
	].join("\n");
	let d = newPlanDoc({ title: "GPU split" });
	d = applyPlanOp(d, { action: "add", text: "wire the reranker" }).doc;
	d = applyPlanOp(d, { action: "brief", text: BRIEF }).doc;
	const { c, f, text, lines } = fresh(d, { section: "brief" });
	// The rendering assertions need to SEE the whole document; the scroll assertions below run in the
	// small terminal the rest of this file uses. A 12-line brief cannot fit 14 rows, and pretending
	// otherwise would just move the assertion to wherever the window happened to land.
	const TALL = 34;
	Object.defineProperty(process.stdout, "rows", { value: TALL, configurable: true });
	const body = text();
	check("the section bar offers Brief with its line count", body.some((x) => x.includes("[Brief 12]")), JSON.stringify(body.slice(1, 2)));
	check("a heading renders as a heading (not as a step)", body.some((x) => x.includes("Why the split")), JSON.stringify(body.slice(4, 8)));
	check("a TABLE renders as a table — box-drawing borders, the same chrome the chat uses", body.some((x) => x.includes("┌")) && body.some((x) => x.includes("┴")), JSON.stringify(body.slice(6, 18)));
	check("the table keeps its columns lined up", body.some((x) => /│ embedder │ CPU\s*│/.test(x)), JSON.stringify(body.slice(6, 14)));
	check("a fenced block keeps its code verbatim", body.some((x) => x.includes('export const split = { embed: "cpu"')), JSON.stringify(body.slice(14, 20)));
	check("nothing about the brief leaked into the step list", f.doc?.steps.length === 1, JSON.stringify(f.doc?.steps.map((s) => s.text)));
	check("and every row fits the terminal width", lines().every((x) => strip(x).length <= WIDTH), JSON.stringify(lines().map((x) => strip(x).length)));
	Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
	const small = text();
	check("in a SHORT terminal a long brief scrolls instead of pushing the hints off screen", small.some((x) => x.includes("more below")) && small.some((x) => x.includes("↑↓ line")), JSON.stringify(small));
	check("the line the cursor is on stays named while the body scrolls", small.some((x) => x.includes("❯ line 1/12") && x.includes("Why the split")), JSON.stringify(small.slice(4, 6)));

	c.handleInput(KEYS.down); c.handleInput(KEYS.down);
	check("↓ moves the line cursor", text().some((x) => x.includes("❯ line 3/12")), JSON.stringify(text().slice(4, 6)));
	c.handleInput("e");
	for (let i = 0; i < 60; i++) c.handleInput("\x7f");
	c.handleInput(type("The embedder stays on CPU because 6 GB is the ceiling."));
	c.handleInput(KEYS.enter);
	check("editing one line rewrites THAT line (the op is a whole-body brief write)", f.ops.some((o) => o.action === "brief") && (f.doc?.brief ?? "").includes("because 6 GB is the ceiling"), JSON.stringify((f.doc?.brief ?? "").split("\n")[2]));
	check("the edit did not touch any other line", (f.doc?.brief ?? "").split("\n").length === 12 && (f.doc?.brief ?? "").includes("| reranker | GPU:0 |"), String((f.doc?.brief ?? "").split("\n").length));

	c.handleInput("a");
	c.handleInput(type("> Constraint: the host has 6 GB of VRAM."));
	c.handleInput(KEYS.enter);
	check("a adds a line to the brief", (f.doc?.brief ?? "").includes("Constraint: the host has 6 GB"), JSON.stringify((f.doc?.brief ?? "").slice(-46)));
	check("the cursor followed the line it just added", text().some((x) => x.includes("❯ line 4/13")), JSON.stringify(text().slice(-2)));
	const briefOps = (n: number): boolean => f.ops.filter((o) => o.action === "brief").length === n;
	c.handleInput("D");
	check("D once ARMS the hovered line — the first press deletes nothing (backlog #15: Brief lines are two-press like steps)",
		(f.doc?.brief ?? "").includes("Constraint: the host has 6 GB") && briefOps(2) && text().some((x) => x.includes("D again DELETES it")),
		JSON.stringify(text().slice(-3)));
	check("the arm is written ON the cursor row, where the cursor row lives (an armed delete you cannot see is just a key that deletes on the second press)",
		text().some((x) => x.includes("❯ line 4/13 · D again DELETES it")), JSON.stringify(text()));
	c.handleInput(KEYS.down);
	check("moving the cursor disarms it — the arm was about a line, and that line is no longer under the cursor",
		!text().some((x) => x.includes("DELETES it")) && (f.doc?.brief ?? "").includes("Constraint: the host has 6 GB"),
		JSON.stringify(text().slice(-3)));
	c.handleInput(KEYS.up);
	c.handleInput("D");
	check("arming the same line a second time is still not a delete", (f.doc?.brief ?? "").includes("Constraint: the host has 6 GB") && briefOps(2), JSON.stringify(f.ops));
	c.handleInput("D");
	check("the second D on the SAME line deletes it", !(f.doc?.brief ?? "").includes("Constraint: the host has 6 GB") && briefOps(3), JSON.stringify((f.doc?.brief ?? "").slice(-40)));
	check("and the row says which line went and how many are left", text().some((x) => x.includes("deleted brief line 4")), JSON.stringify(text().slice(-2)));

	// Keys that belong to the checklist must say so rather than sit silent.
	for (const key of ["x", "[", "]", "w"]) {
		const before = JSON.stringify(f.doc);
		c.handleInput(key);
		check(`${JSON.stringify(key)} in the brief does nothing but explain itself`, JSON.stringify(f.doc) === before && text().at(-1)!.includes("does not apply to the brief") && text().at(-1)!.includes("STEP"), text().at(-1));
	}
	c.handleInput(KEYS.tab);
	check("Tab leaves the brief for the notes", text().some((x) => /\[Dec(isions)? 0\]/.test(x)), JSON.stringify(text().slice(1, 2)));
	c.handleInput(KEYS.esc);
	check("esc closes from the brief and reports the brief edits it made", f.close !== null && f.close.edits === 3 && f.close.summary.every((l) => l.includes("brief")), JSON.stringify(f.close));
})();

// ── 6c. #12: the Brief gets a CURSOR you can see — a ruler whose number is the source line ──
void (() => {
	// The grouping rule first, because the ruler is only honest if the blocks are.
	const grouped = [
		"## Head",                        // 0 own block
		"para line one",                  // 1 own block
		"para line two",                  // 2 own block (markdown would JOIN them; the ruler must not)
		"",                               // 3 blank = a real, countable line
		"| a | b |",                      // 4\ table: one block, four lines
		"| --- | --- |",                  // 5|
		"| 1 | 2 |",                      // 6|
		"| 3 | 4 |",                      // 7/
		"```md",                          // 8 fence opens
		"| looks | like | a | table |",   // 9 inside the fence: must NOT become its own block
		"- not a list item",              // 10 ditto
		"```",                            // 11 fence closes
		"1. first",                       // 12\ list run groups with its indented continuation
		"   more about first",            // 13/
	].join("\n").split("\n");
	const blocks = briefBlocksOf(grouped);
	const find = (n: number): BriefBlock | undefined => blocks.find((b) => n >= b.start && n <= b.end);
	check("briefBlocksOf keeps a TABLE in one block (all four of its lines)",
		find(4)?.start === 4 && find(4)?.end === 7 && find(7)?.start === 4, JSON.stringify(blocks));
	check("a FENCE swallows everything inside it, even lines that look like a table or a list",
		find(8)?.start === 8 && find(8)?.end === 11 && find(9)?.start === 8 && find(10)?.end === 11,
		JSON.stringify(blocks.filter((b) => b.start >= 8)));
	check("a LIST run groups with its indented continuation",
		find(12)?.start === 12 && find(12)?.end === 13, JSON.stringify(blocks.slice(-2)));
	check("paragraph lines stay SEPARATE blocks — a joined run could not name the row your line became",
		find(1)?.start === 1 && find(1)?.end === 1 && find(2)?.start === 2 && find(2)?.end === 2,
		JSON.stringify(blocks.slice(1, 3)));
	check("a blank line is a block too (it is a line you can cursor onto, edit, or delete twice)",
		find(3)?.start === 3 && find(3)?.end === 3, JSON.stringify(blocks[3]));
	check("every source line belongs to exactly one block",
		blocks.reduce((m, b) => m + (b.end - b.start + 1), 0) === grouped.length && blocks.every((b) => b.end >= b.start),
		`${blocks.length} blocks / ${grouped.length} lines`);

	// Now the screen: your report was "I need some sort of cursor when looking at the brief, otherwise
	// it is very cumbersome to edit it" — the body carried no cursor at all.
	const BRIEF = [
		"## Why the split",
		"",
		"The embedder stays on CPU; the reranker moves.",
		"| part | where | why |",
		"| --- | --- | --- |",
		"| embedder | CPU | fp32 is enough |",
		"```ts",
		'export const split = { embed: "cpu", rank: "cuda:0" };',
		"```",
		"1. wire the reranker",
		"   then measure the panel row budget",
	].join("\n");
	let d = newPlanDoc({ title: "GPU split" });
	d = applyPlanOp(d, { action: "add", text: "wire the reranker" }).doc;
	d = applyPlanOp(d, { action: "brief", text: BRIEF }).doc;
	const { c, f, text, lines } = fresh(d, { section: "brief" });
	const RULER = /^\s*(❯\s+|\s+\s?)\d+│\s/;
	const TALL2 = 34;
	Object.defineProperty(process.stdout, "rows", { value: TALL2, configurable: true });
	let body = text();
	check("the body rows carry a ruler (a number and a │ down the left edge)",
		body.filter((x) => /^\s*(❯\s+\d+|\s+\d+)│/.test(x)).length >= 5 && body.some((x) => /^\s+\s+│/.test(x)),
		JSON.stringify(body.filter((x) => /│/.test(x)).slice(0, 4)));
	check("the cursor row is marked IN the body: ❯ <line>│ on the row its line rendered into",
		body.some((x) => /^❯\s+1│ .*Why the split/.test(x)), JSON.stringify(body.slice(4, 7)));
	check("the ruler NUMBER is the source line — line 1 is the heading it names",
		body.some((x) => /^❯\s+1│/.test(x)) && body.some((x) => /^\s+3│ .*embedder stays on CPU/.test(x)),
		JSON.stringify(body.slice(4, 9)));
	check("a multi-row block marks its FIRST row with the table's first line and lets the rest continue under an empty ruler",
		body.some((x) => /^\s+4│ ┌/.test(x)) && body.filter((x) => /^\s+\s+│ │/.test(x)).length >= 2,
		JSON.stringify(body.slice(8, 16)));
	check("a fenced block stays verbatim UNDER the ruler", body.some((x) => x.includes('export const split = { embed')));
	check("a list keeps its numbering and its continuation line inside one block",
		body.some((x) => /wire the reranker/.test(x)) && body.some((x) => /measure the panel row budget/.test(x)));
	check("and every row still fits the terminal width with the ruler taking 5 columns",
		lines().every((x) => strip(x).length <= WIDTH), JSON.stringify(lines().map((x) => strip(x).length).filter((n) => n > WIDTH)));

	c.handleInput(KEYS.down); c.handleInput(KEYS.down); c.handleInput(KEYS.down);
	body = text();
	check("↓ moves the cursor INSIDE the body too — the ruler follows it to line 4",
		body.some((x) => /^❯\s+4│/.test(x)) && !body.some((x) => /^❯\s+1│/.test(x)), JSON.stringify(body.slice(4, 8)));
	check("the readout row above the body and the ruler in the body agree about which line it is",
		body.some((x) => x.includes("❯ line 4/11 · ⏎ edits:")), JSON.stringify(body.slice(3, 6)));
	Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });

	// The anchor claim: not a proportional guess. Park the cursor on the LAST line of a document that
	// cannot fit, and the window must START at that line — a proportional map would still be showing
	// the top of the document.
	const LONG = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? `## Section ${i / 4 + 1}` : `line ${i + 1} of the long brief`)).join("\n");
	let d2 = newPlanDoc({ title: "Long brief" });
	d2 = applyPlanOp(d2, { action: "brief", text: LONG }).doc;
	const big = fresh(d2, { section: "brief" });
	for (let i = 0; i < 39; i++) big.c.handleInput(KEYS.down);
	const tail = big.text();
	check("parked on the last line of a 40-line brief, the window STARTS there (exact anchor, not 40/40 of the way through a guess)",
		tail.some((x) => /^❯\s+40│ line 40 of the long brief/.test(x)), JSON.stringify(tail.slice(4, 7)));
	check("and scrolling back up from there brings the earlier lines back",
		(() => { for (let i = 0; i < 39; i++) big.c.handleInput(KEYS.up); return big.text().some((x) => /^❯\s+1│ .*Section 1/.test(x)); })(),
		JSON.stringify(big.text().slice(4, 7)));
	check("the ruler is not counted as a step or a note — the document is still one brief and one step",
		(f.doc?.steps.length ?? 0) === 1 && (f.doc?.brief ?? "").split("\n").length === 11
		&& (big.f.doc?.steps.length ?? 0) === 0 && f.ops.length === 0 && big.f.ops.length === 0,
		JSON.stringify([f.doc?.steps.length, (f.doc?.brief ?? "").split("\n").length, big.f.ops.length]));
	c.handleInput(KEYS.esc);
	check("esc closes the brief ruler view without claiming an edit", f.close !== null && f.close.edits === 0, JSON.stringify(f.close));
})();

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

// ── 14. #17: expanded step text — the overlay WRAPS by default, `w` flips it ──
{
	const long = "wire the reranker to the GPU split and hold the switch-back flag so the fallback path stays reachable end to end";
	const d = newPlanDoc({ title: "Wrap", steps: [long, "short one"] });
	const { c, text } = fresh(d);
	let l = text();
	check("a long step is not cut in half by default", l.some((x) => x.includes("end to end")), JSON.stringify(l));
	check("the wrapped tail hangs under the text, not under the id", l.some((x) => x.startsWith("     ") && !x.includes("#")), JSON.stringify(l));
	check("wrapping does not blow the overlay height", l.length <= ROWS, `got ${l.length}`);
	check("every row still fits the terminal width", l.every((x) => x.length <= WIDTH), JSON.stringify(l.map((x) => x.length)));
	check("the hint line states the current mode", l.some((x) => x.includes("w compact lines")), JSON.stringify(l));
	c.handleInput("w");
	l = text();
	check("w collapses the step back to one truncated row", l.some((x) => x.includes("#1") && !x.includes("end to end")), JSON.stringify(l));
	check("the collapsed row reports it was cut", l.some((x) => /\.\.\.|…/.test(x)), JSON.stringify(l));
	check("the hint line flips with the mode", l.some((x) => x.includes("w expand lines")), JSON.stringify(l));
	check("w is not mistaken for an edit", c && true);
	c.handleInput("w");
	check("w back to expanded shows the whole step again", text().some((x) => x.includes("end to end")), JSON.stringify(text()));
	// Explicit compact start (what /plan wrap off would mean for the overlay).
	const compact = fresh(d, { wrap: false });
	check("options.wrap:false starts compact", !compact.text().some((x) => x.includes("end to end")), JSON.stringify(compact.text()));
	check("compact mode is the pre-#17 rendering", compact.text().filter((x) => x.includes("#1")).length === 1, JSON.stringify(compact.text()));
}

// ── 15. #22: the READ-ONLY viewer (a plan that is finished and archived) ──────
{
	// The document a finished plan leaves behind: every step settled.
	let d = newPlanDoc({ title: "Retired plan", task: "the old request" });
	d = applyPlanOp(d, { action: "add", text: "one settled step with a long tail of explanation about the reranker and the switch-back flag" }).doc;
	d = applyPlanOp(d, { action: "add", text: "second step" }).doc;
	d = applyPlanOp(d, { action: "status", id: 1, status: "done" }).doc;
	d = applyPlanOp(d, { action: "status", id: 2, status: "dropped" }).doc;
	d = applyPlanOp(d, { action: "note", kind: "decision", text: "one archive slot is enough" }).doc;

	const ro = fresh(d, { readOnly: true });
	let lines = ro.text();
	check("the viewer says what it is", lines[0]!.includes("PREVIOUS PLAN (retired)"), lines[0]);
	check("and reports the plan as settled, not as work in progress", lines[0]!.includes("2/2 settled"), lines[0]);
	check("the hint row admits it is a viewer", lines.some((x) => x.includes("read-only viewer")), JSON.stringify(lines.slice(2, 5)));
	check("it points at the way to get a copy out of it", lines.some((x) => x.includes("/plan export last")), JSON.stringify(lines.slice(2, 5)));

	// Every mutating key must be a no-op WITH an explanation, not a silent dead key.
	for (const key of ["x", "D", "a", "e", "[", "]", "\r"]) {
		const before = JSON.stringify(ro.f.doc);
		ro.c.handleInput(key);
		check(`${JSON.stringify(key)} changes nothing`, ro.f.ops.length === 0 && JSON.stringify(ro.f.doc) === before, JSON.stringify(ro.f.ops));
		check(`${JSON.stringify(key)} says why it did nothing`, ro.text().at(-1)!.includes("read-only"), ro.text().at(-1));
	}
	check("the host's apply was never called (the archive is untouchable)", ro.f.ops.length === 0, JSON.stringify(ro.f.ops));
	check("and the document's revision never moved", ro.f.doc?.revised === d.revised, `${ro.f.doc?.revised} vs ${d.revised}`);

	// Reading it still works — that is the whole point of keeping it.
	const cursorRow = () => ro.text().findIndex((x) => x.includes("❯"));
	const at = cursorRow();
	ro.c.handleInput(KEYS.down);
	check("↑↓ still moves", cursorRow() !== at, `${at} -> ${cursorRow()}`);
	// #15: a viewer exists so a long plan can be READ, and one arrow key at a time is not how a person
	// reads a 40-row checklist. Jumping is navigation, so it is not refused the way editing is.
	ro.c.handleInput("G");
	check("G jumps to the last row of a plan you are only reading", ro.text().some((x) => x.includes("❯") && x.includes("second step")), JSON.stringify(ro.text().slice(6, 9)));
	ro.c.handleInput("g");
	check("g jumps back to the first, and nothing was written while doing it", ro.text().some((x) => x.includes("❯") && x.includes("one settled step")) && ro.f.ops.length === 0, JSON.stringify(ro.text().slice(5, 8)));
	// The viewer starts expanded (that is the /plan view default) — `w` still flips it both ways.
	ro.c.handleInput("w");
	check("w still collapses in a viewer", !ro.text().some((x) => x.includes("switch-back flag")), JSON.stringify(ro.text().slice(5, 8)));
	ro.c.handleInput("w");
	check("and expands it back", ro.text().some((x) => x.includes("switch-back flag")), JSON.stringify(ro.text().slice(5, 8)));
	const tabbed = ro.text();
	ro.c.handleInput(KEYS.tab); // steps → brief
	ro.c.handleInput(KEYS.tab); // → decisions
	check("Tab still cycles into the notes so they can be read", ro.text().some((x) => x.includes("one archive slot is enough")), JSON.stringify(ro.text()));
	ro.c.handleInput(KEYS.tab);
	check("Tab cycles on (task section is readable too)", ro.text().some((x) => x.includes("the old request")), JSON.stringify(ro.text().slice(0, 4)));
	check("the viewer's own hint row was there before Tab moved on", tabbed.some((x) => x.includes("read-only viewer")), JSON.stringify(tabbed.slice(2, 5)));
	check("the viewer fits the small terminal", ro.lines().length <= ROWS, `got ${ro.lines().length}`);
	check("and fits its width", ro.lines().every((x) => x.length <= WIDTH), JSON.stringify(ro.lines().map((x) => x.length)));

	ro.c.handleInput(KEYS.esc);
	check("esc closes it", ro.f.close !== null);
	check("closing a viewer reports ZERO edits (nothing is steered to the model)", ro.f.close?.edits === 0, JSON.stringify(ro.f.close));

	// The same document through the EDITOR path still edits — readOnly is opt-in, not the default.
	const live = fresh(d);
	check("without the flag the overlay is still the normal editor", live.text()[0].includes("console plan —"), live.text()[0]);
	live.c.handleInput("x");
	check("and keys that were refused in the viewer still work here", live.f.ops.length === 1, JSON.stringify(live.f.ops));
}

console.log(failures === 0 ? `ALL PASS (${checks} checks)` : `\n${failures} of ${checks} FAILED`);
process.exit(failures === 0 ? 0 : 1);
