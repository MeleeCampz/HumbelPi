/**
 * Regression test for Shift+arrow selection in the FREE-TEXT DIALOG inputs
 * (extensions/lib/dialog-input.ts → SelectingInput, used by ask_user "Other" and the finish_plan
 * "what should change?" box). backlog #9.
 *
 * That module is pi-tui-ONLY on purpose: the dictionary, pi's key-label and the clipboard writer
 * come in through seams (setDialogSpellPaint / setSubmitKeyLabel / setClipboardWriter), installed
 * by spellcheck.ts in production. Without the seams this test would need @earendil-works/pi-coding-
 * agent, which is ESM-only (no "require" export condition) and therefore unrunnable under tsx —
 * which is how the bug got noticed in the first place, and why the seams exist.
 *
 * The bug is three measurable facts about pi's stock Input — re-probed in section 1 rather than
 * remembered, because wire formats are exactly the thing people get wrong:
 *   1. Shift+Left arrives as ESC [ 1 ; 2 D and Input has no binding for it → the keystroke is
 *      SWALLOWED. Nothing happens, and the user concludes the feature is broken.
 *   2. With the kitty keyboard protocol the same key arrives as ESC [ 8592 ; 2 u, which pi-tui
 *      decodes as U+2190 (←) — a PRINTABLE — and INSERTS "←" into the answer.
 *   3. Ctrl+Shift+Left arrives as ESC [ 1 ; 6 D and NOTHING acts on it — matchesKey knows the name,
 *      pi-tui Input has no binding for it, so the caret does not move either. Word-wise selection
 *      therefore feeds the engine the CTRL-only canonical (ESC [ 1 ; 5 D = a word jump) and extends
 *      the selection itself.
 * So every section checks both halves: selection works, AND no keystroke leaks into the user's
 * text as a stray character.
 *
 * Copies are asserted through the module's clipboard seam (setClipboardWriter): proving the
 * routing must not overwrite the developer's real clipboard.
 *
 * Run: npx tsx tools/test-dialog-select.ts        Exit 0 = all pass.
 */
import { Input, visibleWidth } from "@earendil-works/pi-tui";
import { plainText } from "../extensions/lib/ansi-style.ts";
import {
	SELECTION_OFF,
	SELECTION_ON,
	SpellInput,
	SelectingInput,
	createSpellcheckInputDialog,
	setClipboardWriter,
	setDialogNotifier,
	setDialogSpellPaint,
	type DialogAnswer,
} from "../extensions/lib/dialog-input.ts";
import { unknownWords } from "../extensions/lib/spell-words.ts";
import { isCopyKey } from "../extensions/lib/shift-moves.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  PASS  ${name}`);
	else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// The same switch the main editor uses (/select on|off). Set before any input is built.
const setSelect = (on: boolean): void => {
	const prev = (globalThis as Record<string, unknown>).__humbel_pi_select as { enabled?: boolean } | undefined;
	(globalThis as Record<string, unknown>).__humbel_pi_select = { ...(prev ?? {}), enabled: on };
};
setSelect(true);

// Clipboard seam: captures what a copy WOULD put on the clipboard.
let clipboard: string[] = [];
setClipboardWriter(async (text: string) => { clipboard.push(text); });
/** Copy is fire-and-forget in a keystroke handler (it cannot await the clipboard). */
const settled = (): Promise<void> => new Promise((r) => setImmediate(r));

type Internals = { cursor: number; value: string; pushUndo?: () => void };
const caret = (i: Input): number => (i as unknown as Internals).cursor;

/** Text lands through the bracketed-paste path — the same path the dialog uses for a draft. */
const mk = (text: string): SelectingInput => {
	const i = new SelectingInput({ placeholder: "answer…" });
	if (text) i.handleInput(`\x1b[200~${text}\x1b[201~`);
	return i;
};
const sel = (i: SelectingInput): string | null => i.selectedText();

const SLEFT = "\x1b[1;2D", SRIGHT = "\x1b[1;2C", SEND = "\x1b[1;2F", SHOME = "\x1b[1;2H";
const K_LEFT = "\x1b[8592;2u", K_RIGHT = "\x1b[8594;2u";
const CS_LEFT = "\x1b[1;6D", K_CS_LEFT = "\x1b[8592;6u";
const LEFT = "\x1b[D", RIGHT = "\x1b[C", HOME = "\x1b[H", END = "\x1b[F";
const BACKSPACE = "\x7f", DELETE = "\x1b[3~", CTRL_W = "\x17", CTRL_C = "\u0003", CTRL_A = "\u0001";
const K_CTRL_A = "\x1b[97;5u";
const SHIFT_INSERT = "\x1b[2;2~", K_SHIFT_INSERT = "\x1b[57425;2u", CTRL_SHIFT_C = "\x1b[99;6u";
const MODKEYS_CTRL_SHIFT_C = "\x1b[27;6;99~"; // the same key in xterm's modifyOtherKeys spelling
const INSERT_PLAIN = "\x1b[2~", ALT_INSERT = "\x1b[2;3~", CTRL_ALT_C = "\x1b[99;7u";

/**
 * Column/text assertions all measure a RENDERED line, so they need pi-tui-aware stripping — a regex
 * is not enough: pi draws its hardware-cursor position with two different APC sequences (start and
 * end), and a regex strip leaves "_pi:/fc" plus a BEL as visible characters, which makes "is this
 * line 80 columns wide" measure the marker instead of the line. plainText() is the same tokenizer
 * the styler itself uses, so the measurement and the painting cannot disagree.
 */

/**
 * Extract what pi-tui actually painted with the selection style. TWO things this has to survive:
 *
 * 1. A selection that contains the caret is painted in SEVERAL spans, not one: Input renders
 *    prompt + beforeCaret + CURSOR_MARKER + fakeCursor(caretChar) + afterCaret, and a style must
 *    close before those zero-width sequences (pi strips the markers by exact match) and re-assert
 *    after them. So "one span" is the wrong expectation — the spans are what makes the range
 *    visually contiguous without leaking the style to end-of-line.
 * 2. Between the spans sit pi's own sequences, which must not be counted as selected text.
 */
function paintedRegions(line: string): Array<{ fromCol: number; text: string }> {
	const out: Array<{ fromCol: number; text: string }> = [];
	let i = 0;
	for (;;) {
		const start = line.indexOf(SELECTION_ON, i);
		if (start < 0) return out;
		const end = line.indexOf(SELECTION_OFF, start);
		if (end < 0) return out;
		out.push({
			fromCol: visibleWidth(plainText(line.slice(0, start))),
			text: plainText(line.slice(start + SELECTION_ON.length, end)),
		});
		i = end + SELECTION_OFF.length;
	}
}

function paintedRegion(line: string): { fromCol: number; text: string; spans: number } | null {
	const rs = paintedRegions(line);
	if (rs.length === 0) return null;
	return { fromCol: rs[0]!.fromCol, text: rs.map((r) => r.text).join(""), spans: rs.length };
}

async function main(): Promise<void> {
	// ── 1. ground truth: what stock Input does with these keys (the bug being fixed) ──
	console.log("1. ground truth: pi's stock Input");
	{
		const plain = new Input({});
		plain.handleInput(`\x1b[200~abcdefghij\x1b[201~`);
		const before = plain.getValue();
		plain.handleInput(SLEFT);
		check("stock Input SWALLOWS Shift+Left (no movement, no selection — the #9 complaint)", plain.getValue() === before && caret(plain) === 10, `${JSON.stringify(plain.getValue())} caret=${caret(plain)}`);
		const kitty = new Input({});
		kitty.handleInput(`\x1b[200~abcdefghij\x1b[201~`);
		kitty.handleInput(K_LEFT);
		check("stock Input INSERTS a literal ← for the kitty form", kitty.getValue() === "abcdefghij←", JSON.stringify(kitty.getValue()));
		const word = new Input({});
		word.handleInput(`\x1b[200~hello brave world\x1b[201~`);
		word.handleInput(CS_LEFT);
		check("Ctrl+Shift+Left (ESC[1;6D) is swallowed too — no built-in word selection to reuse", word.getValue() === "hello brave world" && caret(word) === 17, `caret=${caret(word)}`);
	}

	// ── 2. shift selection extends; the text is never touched ──
	console.log("2. shift selection");
	{
		const i = mk("abcdefghij");
		i.handleInput(SLEFT); i.handleInput(SLEFT); i.handleInput(SLEFT);
		check("Shift+Left ×3 selects “hij”", sel(i) === "hij", String(sel(i)));
		check("the text is untouched", i.getValue() === "abcdefghij", JSON.stringify(i.getValue()));
		check("the caret is the lead endpoint", caret(i) === 7, String(caret(i)));
		check("hasSelection()", i.hasSelection() === true);
		i.handleInput(SRIGHT);
		check("Shift+Right shrinks from the lead side", sel(i) === "ij", String(sel(i)));
		const k = mk("abcdefghij");
		k.handleInput(K_LEFT);
		check("kitty CSI-u Shift+Left selects instead of inserting ←", sel(k) === "j" && k.getValue() === "abcdefghij", `${JSON.stringify(k.getValue())} sel=${sel(k)}`);
		k.handleInput(K_RIGHT);
		check("kitty CSI-u Shift+Right collapses an empty selection", k.hasSelection() === false, String(sel(k)));
		const h = mk("one two three");
		h.handleInput(HOME); h.handleInput(SEND);
		check("Home then Shift+End selects the whole answer", sel(h) === "one two three", String(sel(h)));
		const j = mk("one two three");
		j.handleInput(SHOME);
		check("Shift+Home selects backwards to the start", sel(j) === "one two three", String(sel(j)));
	}

	// ── 3. word-wise selection ──
	console.log("3. Ctrl+Shift+arrows (words)");
	{
		const i = mk("hello brave world");
		i.handleInput(CS_LEFT);
		check("Ctrl+Shift+Left selects “world”", sel(i) === "world", String(sel(i)));
		i.handleInput(CS_LEFT);
		check("again extends over “brave”", (sel(i) ?? "").includes("brave") && (sel(i) ?? "").endsWith("world"), String(sel(i)));
		check("text still intact", i.getValue() === "hello brave world", JSON.stringify(i.getValue()));
		const k = mk("hello brave world");
		k.handleInput(K_CS_LEFT);
		check("kitty CSI-u Ctrl+Shift+Left selects a word instead of inserting ←", sel(k) === "world" && k.getValue() === "hello brave world", `${JSON.stringify(k.getValue())} sel=${sel(k)}`);
	}

	// ── 4. Ctrl+A ──
	console.log("4. Ctrl+A selects everything");
	{
		const i = mk("SQLite rules are neat");
		i.handleInput(CTRL_A);
		check("Ctrl+A (control byte) selects the whole value", sel(i) === "SQLite rules are neat", String(sel(i)));
		check("Ctrl+A no longer jumps the caret to line start", caret(i) === 21, String(caret(i)));
		const k = mk("SQLite rules are neat");
		k.handleInput(K_CTRL_A);
		check("kitty CSI-u Ctrl+A selects everything too", sel(k) === "SQLite rules are neat", String(sel(k)));
		const empty = mk("");
		empty.handleInput(CTRL_A);
		check("Ctrl+A on an empty box does nothing silly", empty.hasSelection() === false && empty.getValue() === "");
	}

	// ── 5. typing / Backspace / Delete replace the selection ──
	console.log("5. replace-on-type");
	{
		const spy = mk("SQLite rules are neat");
		let snapshots = 0;
		(spy as unknown as Internals).pushUndo = () => { snapshots++; }; // shadow Input's own pushUndo to observe it
		spy.handleInput(SLEFT); spy.handleInput(SLEFT); spy.handleInput(SLEFT);
		spy.handleInput("x");
		check("typing replaces the selection (editor semantics)", spy.getValue() === "SQLite rules are nx", JSON.stringify(spy.getValue()));
		check("the typed character lands at the collapsed caret", caret(spy) === 19, String(caret(spy)));
		check("the selection is gone after the replace", spy.hasSelection() === false);
		check("our snapshot lands BEFORE Input mutates (then Input snapshots its own insert)", snapshots === 2, `snapshots=${snapshots}`);
		// The semantic guarantee, asserted through pi's own undo rather than through snapshot counts:
		// replace-on-type never silently destroys the range. Two undos: the typed character, then the
		// range the replace deleted.
		const u = mk("SQLite rules are neat");
		u.handleInput(SLEFT); u.handleInput(SLEFT); u.handleInput(SLEFT); // selects "eat"
		u.handleInput("x");
		const undo = (u as unknown as { undo?: () => void }).undo;
		undo?.call(u);
		check("undo 1 removes the typed character (state right after the selection was deleted)", u.getValue() === "SQLite rules are n", JSON.stringify(u.getValue()));
		undo?.call(u);
		check("undo 2 restores the range the replace deleted", u.getValue() === "SQLite rules are neat", JSON.stringify(u.getValue()));
		const bs = mk("SQLite rules are neat");
		bs.handleInput(SLEFT); bs.handleInput(SLEFT); bs.handleInput(SLEFT);
		bs.handleInput(BACKSPACE);
		check("Backspace deletes only the selection", bs.getValue() === "SQLite rules are n", JSON.stringify(bs.getValue()));
		check("Backspace does not ALSO delete the character before the selection", caret(bs) === 18, String(caret(bs)));
		const del = mk("delete this mess");
		del.handleInput(HOME); del.handleInput(SRIGHT); del.handleInput(SRIGHT); del.handleInput(SRIGHT);
		check("selection is “del”", sel(del) === "del", String(sel(del)));
		del.handleInput(DELETE);
		check("Delete removes the selection instead of the character after the caret", del.getValue() === "ete this mess", JSON.stringify(del.getValue()));
		const emoji = mk("fix 😀 typo");
		for (let n = 0; n < 4; n++) emoji.handleInput(SLEFT);
		const hadSel = emoji.hasSelection();
		const before = emoji.getValue();
		emoji.handleInput("z");
		check("typing over a selection that reaches an emoji leaves the surrounding text alone", hadSel && emoji.getValue().startsWith("fix ") && emoji.getValue().endsWith("z") && before.startsWith("fix ") && before.endsWith("typo"), `${JSON.stringify(before)} -> ${JSON.stringify(emoji.getValue())}`);
		check("and it leaves exactly one deletion behind (the selection itself)", emoji.getValue().length < before.length && emoji.getValue().includes("fix"), JSON.stringify(emoji.getValue()));
	}

	// ── 6. plain movement collapses ──
	console.log("6. plain arrows collapse the selection");
	{
		const i = mk("abcdefghij");
		i.handleInput(SLEFT); i.handleInput(SLEFT); i.handleInput(SLEFT);
		i.handleInput(LEFT);
		check("Left collapses to the selection start", i.hasSelection() === false && caret(i) === 7, `sel=${sel(i)} caret=${caret(i)}`);
		i.handleInput(SLEFT);
		check("the next Shift+Left continues from that edge", sel(i) === "g", String(sel(i)));
		const j = mk("abcdefghij");
		j.handleInput(SLEFT); j.handleInput(SLEFT);
		j.handleInput(RIGHT);
		check("Right collapses to the selection end", j.hasSelection() === false && caret(j) === 10, `sel=${sel(j)} caret=${caret(j)}`);
		const h = mk("one two three");
		h.handleInput(CTRL_A); h.handleInput(HOME);
		check("Home collapses too (stock Home behavior survives)", h.hasSelection() === false && caret(h) === 0, `sel=${sel(h)} caret=${caret(h)}`);
		const w = mk("hello brave world");
		w.handleInput(CS_LEFT);
		w.handleInput("\x1b[1;5D"); // plain Ctrl+Left: a word jump, not a selection key
		check("a word jump without Shift collapses rather than leaving a stale range", w.hasSelection() === false && w.getValue() === "hello brave world", JSON.stringify(w.getValue()));
		const sub = mk("sub select");
		sub.handleInput(SLEFT);
		sub.handleInput(CTRL_W);
		check("Ctrl+W clears the selection instead of deleting a stale range", sub.hasSelection() === false, String(sel(sub)));
	}

	// ── 7. copy keys (through the clipboard seam) ──
	console.log("7. copy keys");
	{
		clipboard = [];
		const i = mk("copy the good part");
		for (let n = 0; n < 4; n++) i.handleInput(SLEFT);
		i.handleInput(SHIFT_INSERT);
		await settled();
		check("Shift+Insert copies the selection", clipboard.join("") === "part", JSON.stringify(clipboard));
		check("Shift+Insert does not paste anything into the box", i.getValue() === "copy the good part", JSON.stringify(i.getValue()));
		clipboard = [];
		const k = mk("copy the good part");
		for (let n = 0; n < 4; n++) k.handleInput(SLEFT);
		k.handleInput(K_SHIFT_INSERT);
		await settled();
		check("kitty CSI-u Shift+Insert copies instead of inserting a stray glyph", clipboard.join("") === "part" && k.getValue() === "copy the good part", `${JSON.stringify(clipboard)} ${JSON.stringify(k.getValue())}`);
		clipboard = [];
		const c = mk("copy the good part");
		for (let n = 0; n < 4; n++) c.handleInput(SLEFT);
		c.handleInput(CTRL_SHIFT_C);
		await settled();
		check("Ctrl+Shift+C copies", clipboard.join("") === "part", JSON.stringify(clipboard));
		check("Ctrl+Shift+C does not leak a “c” into the answer", c.getValue() === "copy the good part", JSON.stringify(c.getValue()));
		clipboard = [];
		const mo = mk("copy the good part");
		for (let n = 0; n < 4; n++) mo.handleInput(SLEFT);
		mo.handleInput(MODKEYS_CTRL_SHIFT_C);
		await settled();
		check("modifyOtherKeys Ctrl+Shift+C copies too (the xterm spelling of the same key)",
			clipboard.join("") === "part" && mo.getValue() === "copy the good part",
			`${JSON.stringify(clipboard)} ${JSON.stringify(mo.getValue())}`);
		// Classification boundaries. A copy key that fires on the wrong modifier steals a key the
		// terminal or pi still needs, so the near-misses are checked as firmly as the hits.
		check("plain Insert is not a copy key", isCopyKey(INSERT_PLAIN) === false, JSON.stringify(INSERT_PLAIN));
		check("Alt+Insert is not a copy key", isCopyKey(ALT_INSERT) === false, JSON.stringify(ALT_INSERT));
		check("Ctrl+Alt+C (no shift) is not a copy key", isCopyKey(CTRL_ALT_C) === false, JSON.stringify(CTRL_ALT_C));
		check("Ctrl+C on its own is not a copy key (the host decides copy-vs-cancel)", isCopyKey(CTRL_C) === false);
		check("every Shift+Insert spelling is a copy key",
			isCopyKey(SHIFT_INSERT) && isCopyKey(K_SHIFT_INSERT) && isCopyKey("\x1b[2;4~"),
			`${isCopyKey(SHIFT_INSERT)}/${isCopyKey(K_SHIFT_INSERT)}`);
		check("both Ctrl+Shift+C spellings are copy keys",
			isCopyKey(CTRL_SHIFT_C) && isCopyKey(MODKEYS_CTRL_SHIFT_C),
			`${isCopyKey(CTRL_SHIFT_C)}/${isCopyKey(MODKEYS_CTRL_SHIFT_C)}`);
		clipboard = [];
		const none = mk("nothing selected here");
		none.handleInput(SHIFT_INSERT);
		await settled();
		check("a copy key with no selection copies NOTHING and is not mistaken for paste", clipboard.length === 0 && none.getValue() === "nothing selected here", `${JSON.stringify(clipboard)} ${JSON.stringify(none.getValue())}`);
		const no = mk("abc");
		check("copySelection() reports false with no selection", no.copySelection() === false);
		no.handleInput(SLEFT);
		check("copySelection() reports true with a selection", no.copySelection() === true);
		await settled();
		clipboard = [];

		// What the user SEES. Success is reported inside the dialog (copyStatus -> the bottom border),
		// because a component cannot ask pi for a repaint on its own and the toast measured invisible
		// while a modal dialog was open (.pi/press scenario q). The host notify is kept for the failure
		// paths, which are the ones that must be louder than the box.
		const shown = mk("copy the good part");
		for (let n = 0; n < 4; n++) shown.handleInput(SLEFT);
		check("no copy has happened yet, so nothing is claimed", shown.copyStatus() === null, String(shown.copyStatus()));
		shown.copySelection();
		check("a copy says so in the box, with the length it grabbed", shown.copyStatus() === "copied 4 chars", String(shown.copyStatus()));
		// Double delivery: pi hands a key to the focused input AND to the container that forwarded it.
		// An input that cleared its own copy feedback on entry erased the notice that way — measured in a
		// real pi (.pi/press scenario q: Ctrl+C reported the copy, Shift+Insert reported nothing). The
		// one-clear-per-key therefore belongs to the dialog, and re-feeding the same copy key keeps it.
		shown.handleInput(SHIFT_INSERT);
		check("a copy key re-delivered does not erase its own feedback",
			shown.copyStatus() === "copied 4 chars" && clipboard.length === 2,
			`${JSON.stringify(shown.copyStatus())} copies=${clipboard.length}`);
		check("a re-delivered copy key is idempotent (the same text twice, not two different texts)",
			clipboard[0] === "part" && clipboard[1] === "part", JSON.stringify(clipboard));
		const notes: string[] = [];
		setDialogNotifier((msg: string) => notes.push(msg));
		setClipboardWriter(async () => { throw new Error("no clipboard helper on this box"); });
		check("the seam canary flips when the host installs a writer",
			(globalThis as any).__humbel_pi_dialog_seams?.writer === true,
			JSON.stringify((globalThis as any).__humbel_pi_dialog_seams ?? null));
		const broken = mk("broken clipboard case");
		broken.handleInput(SLEFT);
		check("a copy attempt still reports true (the question was not thrown away because of it)",
			broken.copySelection() === true);
		await settled();
		check("a failing writer replaces the claim with the truth in the box",
			broken.copyStatus() === "copy failed", String(broken.copyStatus()));
		check("and it reaches the host notify too, since the box cannot repaint itself for that",
			notes.some((n) => n.includes("Copy failed") && n.includes("no clipboard helper")), JSON.stringify(notes));
		const unwired = mk("no writer at all");
		setClipboardWriter(null);
		unwired.handleInput(SLEFT);
		unwired.copySelection();
		await settled();
		check("with no clipboard writer it admits it instead of claiming a copy",
			unwired.copyStatus() === "no clipboard writer" && notes.some((n) => n.includes("no clipboard writer")),
			`${unwired.copyStatus()} ${JSON.stringify(notes)}`);
		check("the seam canary reports what the host actually installed (the press test reads this through /probe-state)",
			(globalThis as any).__humbel_pi_dialog_seams?.writer === false &&
			(globalThis as any).__humbel_pi_dialog_seams?.notifier === true,
			JSON.stringify((globalThis as any).__humbel_pi_dialog_seams ?? null));
		setDialogNotifier(undefined);
		setClipboardWriter(async (text: string) => { clipboard.push(text); }); // restore the recording writer for later sections
	}

	// ── 8. paste / programmatic replace ──
	console.log("8. paste and setValue drop the selection");
	{
		const i = mk("abc def");
		for (let n = 0; n < 3; n++) i.handleInput(SLEFT); // "def"
		i.handleInput(`\x1b[200~XYZ\x1b[201~`);
		check("a paste is not read as “typing replaces the selection” (no chunk silently deletes user text)", i.getValue().includes("def") && i.getValue().includes("XYZ"), JSON.stringify(i.getValue()));
		check("the stale endpoints are dropped rather than kept pointing at moved text", i.hasSelection() === false, String(sel(i)));
		const big = mk("first half");
		big.handleInput(SLEFT);
		big.handleInput(`\x1b[200~a\x1b[201~`);
		big.handleInput(`\x1b[200~b\x1b[201~`);
		check("multi-chunk paste lands whole", big.getValue().includes("ab"), JSON.stringify(big.getValue()));
		const v = mk("keep me");
		v.handleInput(SLEFT);
		v.setValue("replaced wholesale");
		check("setValue() clears endpoints that no longer mean anything", v.hasSelection() === false && v.getValue() === "replaced wholesale", String(sel(v)));
	}

	// ── 9. render paints the selection on the right characters ──
	console.log("9. painting");
	{
		const i = mk("abcdefghij");
		for (let n = 0; n < 3; n++) i.handleInput(SLEFT); // "hij", caret sits on its first character
		const line = i.render(80)[0]!;
		const r = paintedRegion(line);
		check("the selection is styled", r !== null, line);
		if (r) {
			// Columns count from the START of the rendered line, which includes Input's prompt ("> " = 2
			// columns) — that offset is part of what the user sees highlighted, not an artifact.
			check(`it starts at the right column (7 + 2 prompt = 9)`, r.fromCol === 9, `fromCol=${r.fromCol}`);
			check("it covers exactly the selected text", r.text === "hij", JSON.stringify(r.text));
			check("the caret sits inside it, so the style splits around pi's cursor sequences (and only there)", r.spans >= 2 && !r.text.includes("g"), `spans=${r.spans}`);
		}
		check("painting does not corrupt the text or the line width", visibleWidth(plainText(line)) === 80, `width=${visibleWidth(plainText(line))}`);
		const mid = mk("select the middle word");
		mid.handleInput(HOME);
		for (let n = 0; n < 11; n++) mid.handleInput(RIGHT); // caret onto the "m" of "middle"
		for (let n = 0; n < 6; n++) mid.handleInput(SRIGHT);
		const mr = paintedRegion(mid.render(80)[0]!);
		check("a selection in the MIDDLE of the answer is painted there", mr !== null && mr.text === "middle", mr ? JSON.stringify(mr.text) : "none");
		if (mr) check("at the right column (11 + 2 prompt = 13)", mr.fromCol === 13, `fromCol=${mr.fromCol}`);
		const wide = mk("数据 plan");
		for (let n = 0; n < 6; n++) wide.handleInput(SLEFT); // "据 plan"
		const wr = paintedRegion(wide.render(80)[0]!);
		// 2 (prompt) + 2 (数 is double-width) — the arithmetic a byte-indexed highlight would get wrong.
		check("double-width characters do not shift the highlight", wr !== null && wr.text === "据 plan" && wr.fromCol === 4, wr ? `${JSON.stringify(wr.text)} fromCol=${wr.fromCol}` : "none");
		// Real coexistence: the spellcheck seam installed exactly like spellcheck.ts installs it.
		setDialogSpellPaint({ enabled: () => true, badWords: (t) => unknownWords(t, new Set(["this", "contain", "mistakes"])) });
		const spell = mk("this containz mistakes");
		for (let n = 0; n < 4; n++) spell.handleInput(SLEFT); // "akes" — inside the misspelled word
		const spellLine = spell.render(80)[0]!;
		const sr = paintedRegion(spellLine);
		check("selection and spellcheck underline coexist on the same characters", sr !== null && sr.text === "akes" && sr.fromCol === 20, sr ? `${JSON.stringify(sr.text)} fromCol=${sr.fromCol}` : "none");
		check("the typo underline is still there on the very same run of characters", /\x1b\[4;91m/.test(spellLine), spellLine);
		check("the unselected part of the answer is still rendered", plainText(spellLine).includes("this"), plainText(spellLine));
		setDialogSpellPaint(null);
	}

	// ── 10. /select OFF keeps stock behavior ──
	console.log("10. /select OFF");
	{
		setSelect(false);
		const i = mk("abcdefghij");
		i.handleInput(SLEFT);
		check("OFF: Shift+Left selects nothing", i.hasSelection() === false && i.getValue() === "abcdefghij", `sel=${sel(i)} ${JSON.stringify(i.getValue())}`);
		i.handleInput(CTRL_A);
		check("OFF: Ctrl+A stays pi's stock line-start jump", i.hasSelection() === false && caret(i) === 0, `sel=${sel(i)} caret=${caret(i)}`);
		const plainLine = mk("xyz").render(80)[0]!;
		setSelect(true);
		const on = mk("xyz");
		on.handleInput(CTRL_A);
		check("the flag is read at RENDER time (a toggle needs no rebuild)", plainLine.indexOf(SELECTION_ON) < 0 && on.render(80)[0]!.indexOf(SELECTION_ON) >= 0);
		const offCopy = mk("abc"); // selection flag ON again; a fresh box has no selection
		check("OFF path leaves the box exactly as stock left it", plainLine.includes("xyz"));
		check("no selection means no copy, ever", offCopy.copySelection() === false);
	}

	// ── 11. bail-out when the caret is not readable ──
	console.log("11. bail-out: no caret internals, no edits");
	{
		const i = mk("abcdefghij");
		(i as unknown as Internals).cursor = undefined as unknown as number; // pi-tui that hides its caret
		i.handleInput(SLEFT);
		check("no internals → no selection", i.hasSelection() === false, String(sel(i)));
		check("no internals → the key is not forwarded as a blind edit", i.getValue() === "abcdefghij", JSON.stringify(i.getValue()));
		check("no internals → nothing painted rather than something wrong", i.render(80)[0]!.indexOf(SELECTION_ON) < 0);
	}

	// ── 12. the dialog itself ──
	console.log("12. the dialog (ask_user “Other” / finish_plan feedback box)");
	{
		const theme = { fg: (_c: string, t: string) => t };
		const answers: DialogAnswer[] = [];
		const d = createSpellcheckInputDialog(theme, "Your answer", "type…", (a) => answers.push(a), {});
		check("the dialog's input IS a SelectingInput (the feature is wired in, not just available)", (d as unknown as { input: unknown }).input instanceof SelectingInput);
		d.handleInput(`\x1b[200~plain draft\x1b[201~`);
		d.handleInput(CTRL_C);
		check("Ctrl+C with NO selection still cancels the whole question (#3 semantics unchanged)", answers.length === 1 && answers[0]!.back === false && answers[0]!.text === undefined, JSON.stringify(answers));

		answers.length = 0; clipboard = [];
		const d2 = createSpellcheckInputDialog(theme, "Your answer", "type…", (a) => answers.push(a), {});
		d2.handleInput(`\x1b[200~SQLite instead of Postgres\x1b[201~`);
		const inp = (d2 as unknown as { input: SelectingInput }).input;
		for (let n = 0; n < 8; n++) inp.handleInput(SLEFT); // "Postgres"
		d2.handleInput(CTRL_C);
		await settled();
		check("Ctrl+C WITH a selection copies it", clipboard.join("") === "Postgres", JSON.stringify(clipboard));
		check("Ctrl+C WITH a selection does NOT close the dialog", answers.length === 0, JSON.stringify(answers));
		check("the draft survives the copy", inp.getValue() === "SQLite instead of Postgres", JSON.stringify(inp.getValue()));
		check("the indicator reports how much was grabbed", d2.render(60).join("\n").includes("⬒ 8"), d2.render(60).join("\n"));
		check("the copy is reported INSIDE the dialog (a notify toast over a running modal measured invisible)",
			d2.render(60).join("\n").includes("copied 8 chars"), d2.render(60).join("\n"));
		d2.handleInput(SRIGHT); // through the dialog, which owns the one-clear-per-key
		check("and the notice is history once the next key arrives", !d2.render(60).join("\n").includes("copied"), d2.render(60).join("\n"));
		d2.handleInput("\x1b");
		check("Esc returns the draft even with a selection active", answers.length === 1 && answers[0]!.back === true && answers[0]!.text === "SQLite instead of Postgres", JSON.stringify(answers));

		answers.length = 0;
		const d3 = createSpellcheckInputDialog(theme, "Your answer", "type…", (a) => answers.push(a), {});
		d3.handleInput(`\x1b[200~final text\x1b[201~`);
		d3.handleInput("\r");
		check("Enter submits what is typed", answers.length === 1 && answers[0]!.back === false && answers[0]!.text === "final text", JSON.stringify(answers));

		answers.length = 0;
		const d4 = createSpellcheckInputDialog(theme, "Your answer", "type…", (a) => answers.push(a), {});
		const inp4 = (d4 as unknown as { input: SelectingInput }).input;
		d4.handleInput(`\x1b[200~measure me\x1b[201~`);
		check("no selection → no indicator", !d4.render(60).join("\n").includes("⬒"), d4.render(60).join("\n"));
		for (let n = 0; n < 4; n++) inp4.handleInput(SLEFT);
		check("selected characters are counted (⬒ 4)", d4.render(60).join("\n").includes("⬒ 4"), d4.render(60).join("\n"));
		check("the hint line advertises the selection keys", d4.render(60).join("\n").includes("shift+arrows") && d4.render(60).join("\n").includes("ctrl+a"));
		d4.dispose();

		answers.length = 0;
		const d5 = createSpellcheckInputDialog(theme, "Your answer", "type…", (a) => answers.push(a), { draft: "SQLite" });
		const inp5 = (d5 as unknown as { input: SelectingInput }).input;
		inp5.handleInput(" for the store");
		check("a restored draft is not mangled by the selection subclass (caret still lands after it)", inp5.getValue() === "SQLite for the store", JSON.stringify(inp5.getValue()));
		d5.dispose();

		answers.length = 0; clipboard = [];
		const d6 = createSpellcheckInputDialog(theme, "Your answer", "type…", (a) => answers.push(a), {});
		const inp6 = (d6 as unknown as { input: SelectingInput }).input;
		d6.handleInput(`\x1b[200~shift insert copies\x1b[201~`);
		for (let n = 0; n < 6; n++) inp6.handleInput(SLEFT); // "copies"
		d6.handleInput(SHIFT_INSERT); // the exact path the press scenario presses
		await settled();
		check("Shift+Insert routed through the dialog copies without touching the question",
			clipboard.join("") === "copies" && answers.length === 0 && inp6.getValue() === "shift insert copies",
			`${JSON.stringify(clipboard)} ${JSON.stringify(answers)}`);
		check("and says so inside the box", d6.render(60).join("\n").includes("copied 6 chars"), d6.render(60).join("\n"));
		d6.handleInput(SHIFT_INSERT);
		await settled();
		check("a double-delivered copy key still shows its notice", d6.render(60).join("\n").includes("copied 6 chars"), d6.render(60).join("\n"));
		d6.dispose();
	}

	// ── 13. the typo seam is wired the way spellcheck.ts wires it ──
	console.log("13. spellcheck seam (lib/spell-words rule + lib/ansi-style painting)");
	{
		const plain = mk("this containz mistakes");
		check("SelectingInput IS a SpellInput (typo highlighting inherited, not replaced)", plain instanceof SpellInput && plain instanceof Input);
		check("with no dictionary installed the field is plain text", !/\x1b\[4;91m/.test(plain.render(80)[0]!));
		// Exactly the seam spellcheck.ts installs (STATE + getDict + unknownWords), with a test dictionary.
		setDialogSpellPaint({ enabled: () => true, badWords: (t) => unknownWords(t, new Set(["this", "contain", "mistakes"])) });
		const line = mk("this containz mistakes").render(80)[0]!;
		check("the unknown word gets underline+red", /\x1b\[4;91m/.test(line), line);
		check("the known words do not", (line.match(/\x1b\[4;91m/g) ?? []).length === 1, line);
		setDialogSpellPaint({ enabled: () => false, badWords: () => new Set() });
		check("/spellcheck off silences the dialog too (the seam is read live, not at build time)", !/\x1b\[4;91m/.test(mk("this containz mistakes").render(80)[0]!));
		setDialogSpellPaint(null);
	}

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
	console.error(`\nTEST CRASHED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
	process.exit(1);
});
