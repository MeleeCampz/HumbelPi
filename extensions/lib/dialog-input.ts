/**
 * dialog-input — the free-text answer box used by ask_user ("Other") and finish_plan
 * ("what should change?"), with Shift selection.
 *
 * Why this is its own module (and not part of spellcheck.ts): it is pi-tui-only — no
 * ExtensionAPI, no dictionary, no clipboard provider — so a regression test can drive it with
 * real keystrokes. spellcheck.ts remains the extension entry and supplies the three things this
 * file deliberately refuses to import (see the seams at the top): the typo dictionary, pi's
 * keybinding labels, and the clipboard writer. Importing them here would drag
 * @earendil-works/pi-coding-agent (ESM-only, no "require" export condition) into every test run.
 *
 * WHAT SELECTION IS BUILT FROM: the classification table (which raw byte string is which key, and
 * why pi's own keybinding table cannot be used for any of it) lives in lib/shift-moves.ts and is
 * shared with the main editor on purpose — the two hosts must classify the same bytes the same way
 * or selection silently differs between the editor and the dialog. The measured ground truth for
 * every byte string is asserted in tools/test-dialog-select.ts section 1.
 */

import { Container, CURSOR_MARKER, Input, Spacer, Text, matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { highlightLine, SELECTION_OFF, SELECTION_ON, styleColumnRange, truncateAnsi } from "./ansi-style";
import { isCopyKey, isCtrlC, isEditingKey, isSelectAllKey, matchShiftMove, plainMoveEdge, selectionEnabled } from "./shift-moves";
import type { DialogAnswer } from "./ask-loop";
export type { DialogAnswer };

// ── Seams: the host (spellcheck.ts) decides these, this file never imports them ────

/** Typo highlighting, supplied by whoever owns the dictionary. null = plain input. */
export interface SpellPaint {
	enabled(): boolean;
	badWords(text: string): Set<string>;
}
let paint: SpellPaint | null = null;
export function setDialogSpellPaint(p: SpellPaint | null): void {
	paint = p;
}

/** Submit-key label for the hint line, from pi's keybinding table ("enter" if unset). */
let submitKeyLabel = "enter";
export function setSubmitKeyLabel(label: string): void {
	if (label) submitKeyLabel = label;
}

/** Clipboard writer. null = the host did not provide one (the copy then reports itself instead of silently failing). */
let clipboardWriter: ((text: string) => Promise<void>) | null = null;
/**
 * Clipboard seam. Production writes through the host's writer (spellcheck.ts wires pi's
 * copyToClipboard); it is settable because (a) a regression test must be able to prove the COPY
 * ROUTING (which key copies, that the keystroke is consumed and not inserted as text) without
 * overwriting the developer's real clipboard, and (b) a host could route copies through its own
 * mechanism (OSC 52 over SSH) without this file knowing which one. Only the writer is swappable —
 * the selection semantics are not.
 */
export function setClipboardWriter(fn: ((text: string) => Promise<void>) | null): void {
	clipboardWriter = fn;
}

/** Host notification surface for copy feedback (guards.ts #14 pattern: re-bound on session_start). */
let notifyUi: ((msg: string) => void) | undefined;
export function setDialogNotifier(fn: ((msg: string) => void) | undefined): void {
	notifyUi = fn;
}
const notify = (msg: string): void => { try { notifyUi?.(msg); } catch { /* stale ctx after a reload — ignore */ } };

// ── Spellchecked single-line input (for dialogs) ─────────────────────────

/** pi-tui Input that highlights unknown words in place while typing. */
export class SpellInput extends Input {
	private cacheText = "\u0000";
	private bad: Set<string> = new Set();

	render(width: number): string[] {
		const lines = super.render(width);
		const p = paint; // the dictionary belongs to the host (spellcheck.ts), not to this file
		if (!p || !p.enabled()) return lines;
		const text = this.getValue();
		if (text !== this.cacheText) {
			this.cacheText = text;
			this.bad = p.badWords(text);
		}
		if (this.bad.size === 0) return lines;
		for (let i = 0; i < lines.length; i++) {
			lines[i] = highlightLine(lines[i]!, this.bad);
		}
		return lines;
	}
}

// ── Shift selection in dialog inputs (backlog #9) ───────────────────────────
//
// backlog #9: Shift+arrow selection works in the MAIN editor (select-editor.ts) but the free-text
// dialogs (ask_user "Other", the finish_plan "what should change?" box) used pi-tui's stock Input,
// where those keys are dead — Shift+arrows are silently swallowed, kitty Shift+arrows come in as
// printable characters and get INSERTED as text. So the dialog box got the exact complaint #9
// names: you cannot select the text you just typed to fix or quote it. Same state machine as
// SelectingEditor, reduced to Input's single-line model (anchor/lead caret, collapsed == no
// selection), built on the shared classification in ./shift-moves so the two hosts stay
// byte-for-byte identical.

/**
 * The parts of Input this feature needs and pi-tui declares private (they are ordinary
 * properties at runtime — TS `private` is compile-time only). Reading them is the whole point:
 * without the caret there is no selection, and Input exposes no caret API. One typed cast
 * instead of scattered `any`: if a future pi-tui ever makes them truly private (#fields), this
 * returns undefined and the selection logic bails out instead of mis-editing the user's answer.
 */
type InputInternals = {
	value: string;
	cursor: number;
	prompt: string;
	renderedStartColumn: number;
	pushUndo?: () => void;
};
const inputInternals = (input: Input): InputInternals | null => {
	const it = input as unknown as InputInternals;
	return typeof it?.cursor === "number" && typeof it.value === "string" ? it : null;
};

/** Re-exported for hosts/tests: the pair the paint below uses, defined once in ./ansi-style. */
export { SELECTION_OFF, SELECTION_ON };

export class SelectingInput extends SpellInput {
	/** Selection endpoints as value-string offsets; null = no selection (reference model). */
	private selStart: number | null = null;
	private selEnd: number | null = null;
	/** Mirror of Input's bracketed-paste state: while pasting, NOTHING is selection logic. */
	private inPaste = false;

	/** Same switch as the main editor (/select on|off) — one feature, one flag, both hosts. */
	private active(): boolean { return selectionEnabled(); }

	private clearSelection(): void { this.selStart = null; this.selEnd = null; }

	/**
	 * Normalized [start, end) offsets, or null when there is no selection. Bounds-proof on purpose:
	 * paste, undo, or a programmatic setValue can move the text out from under an endpoint, and a
	 * stale endpoint would cut the wrong characters out of the user's answer.
	 */
	private normRange(): { s: number; e: number } | null {
		const a = this.selStart, b = this.selEnd;
		if (a === null || b === null) return null;
		const len = this.getValue().length;
		if (a < 0 || b < 0 || a > len || b > len) { this.clearSelection(); return null; }
		if (a === b) return null;
		return a < b ? { s: a, e: b } : { s: b, e: a };
	}

	hasSelection(): boolean { return this.active() && this.normRange() !== null; }

	selectedText(): string | null {
		const r = this.normRange();
		return r ? this.getValue().slice(r.s, r.e) : null;
	}

	/** Selected character count for the border indicator (0 = nothing selected). */
	selectionSize(): number { return this.active() ? [...(this.selectedText() ?? "")].length : 0; }

	/** Ctrl+A (and the raw \x01 byte): select the whole value, caret untouched. */
	private selectAll(): void {
		const len = this.getValue().length;
		if (len === 0) return;
		this.selStart = 0;
		this.selEnd = len;
	}

	/** Delete the selection in place; caret collapses to its start. Undo snapshot FIRST. */
	private deleteSelection(): boolean {
		const r = this.normRange();
		const it = inputInternals(this);
		if (!r || !it) return false;
		it.pushUndo?.(); // two-step undo after replace-on-type (VS Code semantics)
		const v = this.getValue();
		this.setValue(v.slice(0, r.s) + v.slice(r.e));
		it.cursor = r.s; // setValue only CLAMPS the caret, it does not position it
		this.clearSelection();
		return true;
	}

	private async copySelected(text: string): Promise<void> {
		const n = [...text].length;
		if (!clipboardWriter) {
			// No host writer: say so instead of claiming the text is in the clipboard.
			notify("Copy unavailable — no clipboard writer installed");
			return;
		}
		try {
			await clipboardWriter(text);
			notify(`Copied ${n} char${n === 1 ? "" : "s"} to clipboard`);
		} catch (err) {
			notify(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Public because the dialog host owns Ctrl+C: here Ctrl+C means "cancel the whole question",
	 * so the host has to ask whether it is a copy first. Without a selection it stays the cancel key
	 * (unchanged #3 semantics).
	 */
	copySelection(): boolean {
		const text = this.selectedText();
		if (text === null) return false;
		void this.copySelected(text);
		return true;
	}

	override setValue(value: string): void {
		super.setValue(value);
		this.clearSelection(); // programmatic replace — the endpoints may now point anywhere
	}

	override handleInput(data: string): void {
		if (data.includes("\x1b[200~")) this.inPaste = true;
		const pasteStart = data.includes("\x1b[200~");
		const pasteChunk = this.inPaste;
		if (data.includes("\x1b[201~")) this.inPaste = false;
		if (pasteChunk) {
			// Paste is not selection territory in EITHER direction: a multi-chunk paste must not be
			// read as "typing replaces the selection" (that would delete user text one chunk at a
			// time), and the endpoints would now point at text that no longer exists where they think
			// it does. So the selection is dropped and the paste lands at the caret like any paste.
			// Dropping is the recoverable direction: an extra insertion is fixable, deleting the wrong
			// range silently is not.
			if (pasteStart) this.clearSelection();
			super.handleInput(data);
			return;
		}
		if (!this.active()) {
			super.handleInput(data);
			return;
		}

		// Copy keys: shift+insert, ctrl+shift+c, kitty Shift+Insert. Only with a live selection.
		if (this.hasSelection() && isCopyKey(data)) {
			this.copySelection();
			return;
		}

		// Ctrl+A — select all. Stock Input binds ctrl+a to cursorLineStart; selecting mode
		// repurposes it (same policy as the main editor; /select off restores stock behavior).
		if (isSelectAllKey(data)) {
			this.selectAll();
			return;
		}

		// Typing / Backspace / Delete REPLACE the selection, then the key acts at the caret.
		if (this.hasSelection() && isEditingKey(data)) {
			this.deleteSelection();
			if (matchesKey(data, "backspace") || matchesKey(data, "delete")) return;
			super.handleInput(data);
			return;
		}

		// Shift-movement: anchor the selection at the caret, then let pi move the caret. The raw
		// wire sequence is replaced by a CANONICAL plain sequence — that is what fixes both the
		// swallowed ESC[1;2D and the kitty CSI-u inserting a literal "←" into the text.
		const plain = matchShiftMove(data);
		if (plain !== null) {
			const it = inputInternals(this);
			if (!it) return; // pi-tui without a readable caret: do nothing rather than guess
			if (this.selStart === null) this.selStart = it.cursor;
			const before = this.getValue();
			super.handleInput(plain);
			// If that key EDITED instead of moving, the endpoints are meaningless — drop the
			// selection rather than risk a bad edit later.
			if (this.getValue() !== before) this.clearSelection();
			else this.selEnd = it.cursor;
			return;
		}

		// A plain movement key COLLAPSES the selection to the edge in the pressed direction and
		// consumes the key (reference-impl policy). Every other key drops the selection and acts
		// exactly as it did before this feature (Enter submit, Esc back, Ctrl+W clear, word jumps…).
		if (this.hasSelection()) {
			const rng = this.normRange()!;
			const edge = plainMoveEdge(data, { multiline: false }); // Input has no line movement
			this.clearSelection();
			if (edge) {
				const it = inputInternals(this);
				if (it) it.cursor = edge === "start" ? rng.s : rng.e;
				return;
			}
		}

		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width); // Input layout + spellcheck highlight
		const rng = this.active() ? this.normRange() : null;
		if (!rng || lines.length === 0) return lines;
		const painted = this.paintSelection(lines[0]!, rng);
		if (painted !== null) lines[0] = painted;
		return lines;
	}

	/**
	 * Map the selection onto the line Input already rendered. Input lays out
	 *   prompt + beforeCaret + CURSOR_MARKER + reverseVideo(caretChar) + afterCaret + padding
	 * and stores the horizontal scroll window's start column in `renderedStartColumn`, so the
	 * selection's columns are DERIVED from the value (searching for the selected text would be
	 * ambiguous — the same word can appear twice in one answer).
	 * Column arithmetic is grapheme-safe via visibleWidth on the value prefixes, which is how Input
	 * computes its own caret column. Returns null (skip the paint) if the numbers do not add up:
	 * a wrong range would style the wrong characters of the user's text, which is worse than none.
	 */
	private paintSelection(line: string, rng: { s: number; e: number }): string | null {
		const it = inputInternals(this);
		if (!it) return null;
		const value = this.getValue();
		if (rng.e > value.length || rng.s >= rng.e) return null;
		const base = visibleWidth(it.prompt);
		const startCol = Number.isFinite(it.renderedStartColumn) ? Math.max(0, it.renderedStartColumn) : 0;
		const selStartCol = visibleWidth(value.slice(0, rng.s));
		const selEndCol = visibleWidth(value.slice(0, rng.e));
		const c1 = base + Math.max(0, selStartCol - startCol);
		const c2 = base + Math.max(0, selEndCol - startCol);
		if (c2 <= c1 || c1 < base) return null;
		// styleColumnRange is ANSI-safe: zero-width sequences inside the range (the hardware cursor
		// marker, the caret's own reverse video, spellcheck colors) are preserved and the selection
		// style is re-asserted after them — so a selection that spans the caret is still painted.
		return styleColumnRange(line, c1, c2, SELECTION_ON, SELECTION_OFF);
	}
}

/**
 * Single-line input dialog with live typo highlighting — a lookalike of pi's built-in
 * extension input (what ctx.ui.input shows) for use via ctx.ui.custom.
 *
 * Keys (HumbelPi #3 / the ask_user "Other" door):
 *   Enter   submit what is typed
 *   Esc     go BACK to whatever preceded this dialog (the option list), carrying the text
 *           so the draft is not lost — this is what used to be a one-way cancel
 *   Ctrl+C  cancel the whole question
 *
 * Keys added by #9 (shift selection in input boxes), active while /select is ON — the same
 * affordances the main editor has, so the box you type plan feedback into is not the one place
 * they do not work:
 *   Shift+arrows  select (Ctrl+Shift+Left/Right by words)   Ctrl+A  select all
 *   Shift+Insert / Ctrl+Shift+C / Ctrl+C  copy the selection (Ctrl+C still cancels when nothing
 *                 is selected — the #3 cancel semantics are unchanged)
 *   typing / Backspace / Delete replace the selection; a plain arrow collapses it to that edge
 *
 * Renders plain when spellcheck is toggled off.
 *
 * Deliberately does NOT use pi's DynamicBorder/keyHint — those read pi's internal theme
 * singleton; everything here is styled with the theme passed in by ctx.ui.custom.
 */
class SpellcheckInputDialog extends Container implements Focusable {
	private readonly input: SelectingInput;
	private _focused = false;

	get focused() { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }

	constructor(
		private readonly theme: { fg(color: string, text: string): string },
		title: string,
		placeholder: string,
		private readonly done: (answer: DialogAnswer) => void,
		options?: { draft?: string; backLabel?: string },
	) {
		super();
		// #9: SelectingInput IS a SpellInput (typo highlighting untouched) — it only adds the
		// selection state machine, and it self-disables when /select is off, so a stock box is one
		// flag away.
		this.input = new SelectingInput({ placeholder });
		// A trip back to the option list and back here again must not lose what was typed.
		// pi-tui's Input.setValue() clamps the caret to the START of the value, which would make
		// the next character land before the restored draft ("SQLite" + typed " for the store"
		// came back as "for the storeSQLite"). Feeding the draft through the input's own bracketed-
		// paste path inserts it at the caret and leaves the caret after it, exactly like pasting.
		if (options?.draft) this.input.handleInput(`\x1b[200~${options.draft}\x1b[201~`);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		const backLabel = options?.backLabel ?? "back to options";
		const selHint = selectionEnabled()
			? `  ${this.theme.fg("dim", "shift+arrows")} ${this.theme.fg("muted", "select")}  ${this.theme.fg("dim", "ctrl+a")} ${this.theme.fg("muted", "all")}  ${this.theme.fg("dim", "ctrl+c")} ${this.theme.fg("muted", "copy")}`
			: "";
		this.addChild(new Text(`${this.theme.fg("dim", submitKeyLabel)} ${this.theme.fg("muted", "submit")}  ${this.theme.fg("dim", "esc")} ${this.theme.fg("muted", backLabel)}  ${this.theme.fg("dim", "ctrl+c")} ${this.theme.fg("muted", "cancel")}${selHint}`, 1, 0));
		this.addChild(new Spacer(1));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter") || data === "\n") { this.done({ text: this.input.getValue(), back: false }); return; }
		// Esc = back to the option list, draft included (a selection goes with the draft: the text
		// is restored whole, and #3's "never lose what was typed" rule outranks clearing a range).
		if (matchesKey(data, "escape")) { this.done({ text: this.input.getValue(), back: true }); return; }
		// Ctrl+C: COPY when something is selected (#9), otherwise cancel the whole question (#3).
		// The order is deliberate — Ctrl+C is the dialog's only cancel key, so it may only be spent
		// on a copy when there is something to copy.
		if (matchesKey(data, "ctrl+c") || isCtrlC(data)) {
			if (this.input.copySelection()) return;
			this.done({ back: false }); // discards the draft
			return;
		}
		this.input.handleInput(data);
	}

	override render(width: number): string[] {
		const border = this.theme.fg("border", "─".repeat(Math.max(4, width)));
		const lines = super.render(width);
		// Selection indicator, on the BOTTOM border (same glyph/shape as the main editor's "⬒ N"): a
		// gray background on short or similar-looking text is easy to miss, and "how much did I grab?"
		// is the question the copy then answers. It goes on the border rather than on the last child
		// because the last child is a Spacer — appending there leaves the label invisible.
		const n = this.input.selectionSize();
		let bottom = border;
		if (n > 0) {
			const label = ` \u2B12 ${n} `;
			bottom = truncateAnsi(border, Math.max(4, width - label.length)) + label;
		}
		return [border, ...lines, bottom];
	}

	dispose(): void {}
}

/** Factory for ctx.ui.custom — see SpellcheckInputDialog. */
export function createSpellcheckInputDialog(
	theme: { fg(color: string, text: string): string },
	title: string,
	placeholder: string,
	done: (answer: DialogAnswer) => void,
	options?: { draft?: string; backLabel?: string },
): SpellcheckInputDialog {
	return new SpellcheckInputDialog(theme, title, placeholder, done, options);
}

