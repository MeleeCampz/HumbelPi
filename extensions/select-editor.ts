/**
 * Select-Editor Extension (shift-based text selection in the input)
 *
 * Turns pi's DEAD Shift+arrow keys into standard text selection in the main
 * input editor, with copy to the system clipboard. Design mirrors the
 * oh-my-pi reference implementation (PR #1310: "text selection — Ctrl+A,
 * Shift+Arrow, Ctrl+C copy") adapted for use as an external extension:
 * instead of patching core Editor internals we extend SpellcheckEditor and
 * post-process its rendered output.
 *
 * How it works
 * - SelectingEditor extends SpellcheckEditor (so typo highlighting keeps
 *   working) and overrides handleInput/render/setText only.
 * - Selection state: explicit selStart/selEnd document positions (reference
 *   model), held on the instance; collapsed == no selection.
 * - Shift+Left/Right/Up/Down/Home/End (+ Ctrl+Shift word jumps) set
 *   selStart on first press, synthesize the PLAIN movement sequence into
 *   super.handleInput() so pi's own grapheme-aware engine moves the caret,
 *   then pin selEnd to the new caret.
 * - Ctrl+A selects all (pi stock binds ctrl+a to line-start; selection mode
 *   repurposes it, matching the reference impl — /select off restores stock).
 * - Standard editing semantics while a selection is active: typing / Backspace
 *   / Delete REPLACE the selection (undo snapshot taken first → two-step undo,
 *   range deleted in place, caret collapses to its start, then the key is
 *   processed normally; Backspace/Delete are consumed). Plain arrows collapse
 *   to the edge in the pressed direction; other keys clear the selection.
 * - Copy: Shift+Insert, Ctrl+Shift+C, or Ctrl+C while a non-collapsed
 *   selection exists (consumed — without a selection Ctrl+C falls through to
 *   pi's app.clear, so double-Ctrl+C behavior is preserved). Uses pi's own
 *   exported copyToClipboard() (native → WSL interop → OSC 52).
 * - Visibility: the selected range is drawn with a gray background (ANSI-safe,
 *   composes with spellcheck red and the inverted cursor — unlike the
 *   reference's reverse video, which double-inverts under the caret), plus a
 *   "⬒ N" indicator on the editor's bottom border.
 *
 * Editor ownership
 * spellcheck.ts ALSO installs a custom editor. Two owners would clobber each
 * other (last setEditorComponent wins), so this extension is the single owner:
 * applyEditor() picks SelectingEditor / bare SpellcheckEditor / undefined from
 * both flags and runs on session_start (idempotent, order-independent).
 * spellcheck.ts reads our flag from globalThis (no import — no cycle) and only
 * installs when selection is OFF. Flags live on globalThis because pi loads
 * each extension file through jiti with moduleCache disabled (separate module
 * instances per importer).
 *
 * Toggle: /select on | off | status  (default ON, persisted in guard state)
 */

import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { SpellcheckEditor, styleColumnRange, truncateAnsi } from "./spellcheck";
import { loadGuardState, updateGuardState } from "./lib/session-state";

// ── Shared state (globalThis — jiti double-instance safe) ────────────────

interface SelectState { enabled: boolean }
const SELECT: SelectState = ((globalThis as Record<string, unknown>).__humbel_pi_select ??= {
	enabled: loadGuardState().selectionMode ?? true,
}) as SelectState;

/** Latest ctx for notifications — refreshed on session_start (guards.ts #14 pattern). */
let notifyUi: ((msg: string) => void) | undefined;
const notify = (msg: string): void => { try { notifyUi?.(msg); } catch { /* stale ctx after reload — ignore */ } };

// ── Key mapping ───────────────────────────────────────────────────────────

/** Shift-movement key → the PLAIN sequence pi's editor already understands. */
const SHIFT_MOVES: Array<[string, string]> = [
	["shift+left", "\x1b[D"],
	["shift+right", "\x1b[C"],
	["shift+up", "\x1b[A"],
	["shift+down", "\x1b[B"],
	["shift+home", "\x1b[H"],
	["shift+end", "\x1b[F"],
	["ctrl+shift+left", "\x1b[1;5D"],
	["ctrl+shift+right", "\x1b[1;5C"],
];

/**
 * Raw-sequence fallback for Shift+arrows (reference impl found matchesKey
 * unreliable in some environments). Covers the modified-arrow form
 * ESC[1;mX and kitty CSI-u. Wire modifier encoding (per pi's own parser,
 * keys.js parseKittySequence): bitmask = wireValue - 1, with shift = bit 0 —
 * so Shift is present when ((m - 1) & 1) !== 0 (wire 2=shift, 3=alt, 4=shift+alt…).
 */
const RAW_SHIFT_ARROW = /^\x1b\[(\d+);(\d+)([ABCDHF])$/;
const RAW_KITTY_SHIFT_MOVE = /^\x1b\[(8592|8593|8594|8595|8963|8964);(\d+)u$/;
const KITTY_MOVE_SEQ: Record<string, string> = {
	"8592": "\x1b[D", "8594": "\x1b[C", "8593": "\x1b[A", "8595": "\x1b[B",
	"8963": "\x1b[H", "8964": "\x1b[F",
};
/** Kitty CSI-u for Shift+Insert (U+21E5; 57425 is pi's mapped variant). */
const RAW_KITTY_SHIFT_INSERT = /^\x1b\[(8677|57425);(\d+)u$/;

const hasShiftWireMod = (wireMod: string): boolean => ((parseInt(wireMod, 10) - 1) & 1) !== 0;
const hasCtrlWireMod = (wireMod: string): boolean => ((parseInt(wireMod, 10) - 1) & 4) !== 0;

function matchShiftMove(data: string): string | null {
	for (const [key, seq] of SHIFT_MOVES) if (matchesKey(data, key)) return seq;
	let m = RAW_SHIFT_ARROW.exec(data);
	if (m && hasShiftWireMod(m[2])) {
		// Ctrl bit + left/right → word jump (reference: shift+ctrl+arrow
		// extends selection by words even when matchesKey is unreliable).
		if (hasCtrlWireMod(m[2]) && (m[3] === "D" || m[3] === "C")) {
			return m[3] === "D" ? "\x1b[1;5D" : "\x1b[1;5C";
		}
		const plain: Record<string, string> = { D: "\x1b[D", C: "\x1b[C", A: "\x1b[A", B: "\x1b[B", H: "\x1b[H", F: "\x1b[F" };
		return plain[m[3]] ?? null;
	}
	m = RAW_KITTY_SHIFT_MOVE.exec(data);
	if (m && hasShiftWireMod(m[2])) return KITTY_MOVE_SEQ[m[1]] ?? null;
	return null;
}

// ── Editor ────────────────────────────────────────────────────────────────

interface DocPos { line: number; col: number }

class SelectingEditor extends SpellcheckEditor {
	/** Explicit selection endpoints (reference model); null = no selection. */
	private selStart: DocPos | null = null;
	private selEnd: DocPos | null = null;

	/** Caret position from the (TS-private, runtime-public) editor state. */
	private caretPos(): DocPos | null {
		const st = (this as unknown as { state?: { lines: string[]; cursorLine: number; cursorCol: number } }).state;
		if (!st) return null;
		return { line: st.cursorLine, col: st.cursorCol };
	}

	private setCaret(p: DocPos): void {
		const anyThis = this as unknown as { state: { lines: string[]; cursorLine: number; cursorCol: number }; setCursorCol?: (c: number) => void; tui?: { requestRender?: () => void } };
		anyThis.state.cursorLine = p.line;
		if (typeof anyThis.setCursorCol === "function") anyThis.setCursorCol(p.col);
		else anyThis.state.cursorCol = p.col;
		anyThis.tui?.requestRender?.();
	}

	private clearSelection(): void {
		this.selStart = null;
		this.selEnd = null;
	}

	/** Normalized (document-order) selection range, or null when none/collapsed. */
	private normRange(): { s: DocPos; e: DocPos } | null {
		const a = this.selStart, b = this.selEnd;
		if (!a || !b) return null;
		const st = (this as unknown as { state?: { lines: string[] } }).state;
		if (!st) return null;
		// Stale-proofing: if an endpoint fell out of bounds because text
		// changed underneath us, drop the selection rather than risk a bad edit.
		if (a.line < 0 || b.line < 0 || a.line >= st.lines.length || b.line >= st.lines.length) return null;
		if (a.line === b.line && a.col === b.col) return null;
		const startFirst = a.line < b.line || (a.line === b.line && a.col <= b.col);
		return { s: startFirst ? a : b, e: startFirst ? b : a };
	}

	private hasSelection(): boolean { return this.normRange() !== null; }

	/** Select the whole document (caret stays in place). */
	private selectAll(): void {
		const st = (this as unknown as { state?: { lines: string[] } }).state;
		if (!st || st.lines.length === 0) return;
		this.selStart = { line: 0, col: 0 };
		const last = st.lines.length - 1;
		this.selEnd = { line: last, col: (st.lines[last] ?? "").length };
	}

	/** Selected text in document order, or null when no/collapsed selection. */
	getSelectedText(): string | null {
		const rng = this.normRange();
		if (!rng) return null;
		const st = (this as unknown as { state?: { lines: string[] } }).state;
		if (!st) return null;
		const { s, e } = rng;
		const parts: string[] = [];
		for (let i = s.line; i <= e.line; i++) {
			const ln = st.lines[i] ?? "";
			parts.push(ln.slice(i === s.line ? s.col : 0, i === e.line ? e.col : ln.length));
		}
		return parts.join("\n");
	}

	private async copySelected(text: string): Promise<void> {
		try {
			await copyToClipboard(text);
			notify(`Copied ${text.length} char${text.length === 1 ? "" : "s"} to clipboard`);
		} catch (err) {
			notify(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Printable char / Backspace / Delete — the keys that edit text in place. */
	private isEditingKey(data: string): boolean {
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) return true;
		// Single printable code point (astral-safe: emoji are 2 UTF-16 units).
		const cps = [...data];
		return cps.length === 1 && cps[0]!.charCodeAt(0) >= 32;
	}

	private isRawShiftInsert(data: string): boolean {
		const m = RAW_KITTY_SHIFT_INSERT.exec(data);
		return !!m && hasShiftWireMod(m[2]!);
	}

	/** Delete the active selection in place; caret collapses to its start. */
	private deleteSelection(): boolean {
		const rng = this.normRange();
		if (!rng) return false;
		const st = (this as unknown as { state?: { lines: string[] } }).state;
		if (!st) return false;
		// Undo snapshot BEFORE mutating (UndoStack clones on push): replace-on-
		// type then gives two-step undo — first ctrl+z restores the deleted
		// range, second restores everything (VS Code semantics).
		try { (this as unknown as { pushUndoSnapshot?: () => void }).pushUndoSnapshot?.(); } catch { /* older pi — ignore */ }
		const { s, e } = rng;
		if (s.line === e.line) {
			const ln = st.lines[s.line] ?? "";
			st.lines[s.line] = ln.slice(0, s.col) + ln.slice(e.col);
		} else {
			const head = (st.lines[s.line] ?? "").slice(0, s.col);
			const tail = (st.lines[e.line] ?? "").slice(e.col);
			st.lines.splice(s.line, e.line - s.line + 1, head + tail);
		}
		this.clearSelection();
		this.setCaret(s);
		return true;
	}

	override handleInput(data: string): void {
		// Copy keys — only with a live selection.
		if (this.hasSelection()) {
			const text = this.getSelectedText();
			if (text !== null && (matchesKey(data, "shift+insert") || matchesKey(data, "ctrl+shift+c") || this.isRawShiftInsert(data))) {
				void this.copySelected(text);
				return;
			}
			// Ctrl+C with an active selection copies and is consumed; without a
			// selection it falls through to pi's app.clear (double-Ctrl+C preserved).
			if (matchesKey(data, "ctrl+c")) {
				void this.copySelected(text);
				return;
			}
		}

		// Ctrl+A — select all. Pi stock binds ctrl+a to line-start; selection
		// mode repurposes it (reference impl). Raw \x01 covers terminals that
		// send the plain control byte.
		if (matchesKey(data, "ctrl+a") || data === "\u0001") {
			this.selectAll();
			return;
		}

		// Standard editing semantics with an active selection: typing / Backspace
		// / Delete replace the selection — delete it in place, then process the
		// key at the collapsed caret (Backspace/Delete are consumed).
		if (this.hasSelection() && this.isEditingKey(data)) {
			this.deleteSelection();
			if (matchesKey(data, "backspace") || matchesKey(data, "delete")) return;
			super.handleInput(data);
			return;
		}

		// Shift-movement: start the selection, then let pi move the caret.
		const plain = matchShiftMove(data);
		if (plain !== null) {
			if (!this.selStart) this.selStart = this.caretPos();
			const before = this.getText();
			super.handleInput(plain);
			// If the key replaced the text instead of moving the caret (up/down
			// trigger pi's history navigation at line boundaries), the endpoints
			// are meaningless — drop the selection (reference-impl behavior).
			if (this.getText() !== before) this.clearSelection();
			else this.selEnd = this.caretPos();
			return;
		}

		// Any other key: a plain arrow collapses to the edge in the pressed
		// direction and consumes the key (reference-impl policy); anything else
		// just clears the selection and proceeds normally.
		if (this.hasSelection()) {
			const rng = this.normRange()!;
			this.clearSelection();
			const dirLeft = matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "home");
			const dirRight = matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "end");
			if (dirLeft) { this.setCaret(rng.s); return; }
			if (dirRight) { this.setCaret(rng.e); return; }
		}

		super.handleInput(data);
	}

	override setText(text: string): void {
		super.setText(text);
		// Programmatic replace — selection endpoints may now be stale.
		this.clearSelection();
	}

	override render(width: number): string[] {
		const lines = super.render(width); // base + spellcheck layer
		if (lines.length < 3) return lines;
		const text = this.getSelectedText();
		if (text === null) return lines;

		this.paintSelection(lines, width);

		// Border indicator (ANSI-safe truncation — theme borders may carry
		// escape sequences that truncateToWidth would slice through).
		const label = ` \u2B12 ${[...text].length} `;
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateAnsi(lines[last]!, width - label.length) + label;
		}
		return lines;
	}

	/**
	 * Map logical lines onto rendered layout entries by consuming the editor's
	 * own layoutText() output — the exact layout core used this frame (same
	 * wrap algorithm, same paste-marker-aware segmentation). Chunk texts are
	 * exact slices that tile each wrapped line, so character ranges are
	 * recovered by walking; any mismatch returns null (skip the paint).
	 */
	private buildLayoutEntries(layoutWidth: number): Array<{ lineIdx: number; s: number; e: number; text: string }> | null {
		const host = this as unknown as { layoutText?: (w: number) => Array<{ text?: string }> };
		const raw = typeof host.layoutText === "function" ? host.layoutText(layoutWidth) : null;
		if (!Array.isArray(raw)) return null;
		const entries: Array<{ lineIdx: number; s: number; e: number; text: string }> = [];
		let j = 0;
		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] ?? "";
			if (visibleWidth(line) <= layoutWidth) {
				if (j >= raw.length || (raw[j]?.text ?? "") !== line) return null;
				entries.push({ lineIdx: i, s: 0, e: line.length, text: line });
				j++;
			} else {
				let pos = 0;
				while (pos < line.length) {
					if (j >= raw.length) return null;
					const t = raw[j]?.text ?? "";
					if (t.length === 0 || !line.startsWith(t, pos)) return null;
					entries.push({ lineIdx: i, s: pos, e: pos + t.length, text: t });
					pos += t.length;
					j++;
				}
			}
		}
		return j === raw.length ? entries : null;
	}

	/**
	 * Paint the selected range with a gray background on the rendered content
	 * lines. Maps document coordinates onto visible columns using the editor's
	 * own layoutText() output (zero drift by construction); if the layout can't
	 * be recovered (e.g. pi renamed layoutText) or disagrees with what core
	 * rendered, a sanity check skips the highlight for that frame (indicator
	 * still works).
	 */
	private paintSelection(lines: string[], width: number): void {
		try {
			const rng = this.normRange();
			if (!rng) return;
			const ed = this as unknown as {
				state?: { lines: string[] };
				paddingX?: number;
				scrollOffset?: number;
				renderedVisibleLineCount?: number;
				tui?: { terminal?: { rows?: number } };
			};
			const st = ed.state;
			if (!st || typeof ed.scrollOffset !== "number" || typeof ed.renderedVisibleLineCount !== "number") return;

			// Same width math as core render().
			const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
			const paddingX = Math.min(ed.paddingX ?? 0, maxPadding);
			const contentWidth = Math.max(1, width - paddingX * 2);
			const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

			// Layout entries: one per rendered content line, with the char range
			// of the logical line it covers (from core's own layout this frame).
			const entries = this.buildLayoutEntries(layoutWidth);
			if (!entries) return;

			const scrollOffset = ed.scrollOffset;
			const visibleCount = ed.renderedVisibleLineCount;
			const maxVisible = Math.max(5, Math.floor(((ed.tui?.terminal?.rows) ?? 24) * 0.3));
			if (entries.length < scrollOffset + visibleCount || entries.length - (scrollOffset + visibleCount) > maxVisible) return;

			const { s, e } = rng;
			for (let r = scrollOffset; r < scrollOffset + visibleCount && r < entries.length; r++) {
				const en = entries[r]!;
				if (en.lineIdx < s.line || en.lineIdx > e.line) continue;
				let cs = en.s, ce = en.e;
				if (en.lineIdx === s.line && s.col > cs) cs = s.col;
				if (en.lineIdx === e.line && e.col < ce) ce = e.col;
				if (ce <= cs) continue;
				// Char offsets → visible columns within the chunk text.
				const colStart = paddingX + visibleWidth(en.text.slice(0, cs - en.s));
				const colEnd = paddingX + visibleWidth(en.text.slice(0, ce - en.s));
				if (colEnd <= colStart) continue;
				const renderedIdx = 1 + (r - scrollOffset);
				if (renderedIdx >= 1 && renderedIdx < lines.length - 1) {
					lines[renderedIdx] = styleColumnRange(lines[renderedIdx]!, colStart, colEnd, "\x1b[48;5;236m", "\x1b[49m");
				}
			}
		} catch { /* layout internals unavailable/changed — skip highlight */ }
	}
}

// ── Editor ownership (single owner — see file header) ─────────────────────

function applyEditor(ctx: ExtensionContext): void {
	const spellOn = ((globalThis as Record<string, unknown>).__humbel_pi_spellcheck as SelectState | undefined)?.enabled ?? false;
	if (SELECT.enabled) {
		ctx.ui.setEditorComponent((tui, theme, kb) => new SelectingEditor(tui, theme, kb));
	} else if (spellOn) {
		ctx.ui.setEditorComponent((tui, theme, kb) => new SpellcheckEditor(tui, theme, kb));
	} else {
		ctx.ui.setEditorComponent(undefined);
	}
}

function persist(): void {
	try { updateGuardState((s) => { s.selectionMode = SELECT.enabled; }); } catch { /* non-fatal */ }
}

// ── Extension entry ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		notifyUi = (msg) => ctx.ui.notify(msg, "info");
		applyEditor(ctx); // idempotent + order-independent vs spellcheck's install
	});

	pi.registerCommand("select", {
		description: "Shift+arrow text selection in the input: /select on | off | status",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			if (a === "on") {
				SELECT.enabled = true;
				persist();
				applyEditor(ctx);
				ctx.ui.notify("Shift-select in input: ON  (shift+arrows select · ctrl+a all · shift+insert / ctrl+shift+c / ctrl+c copy)", "info");
			} else if (a === "off") {
				SELECT.enabled = false;
				persist();
				applyEditor(ctx);
				ctx.ui.notify("Shift-select in input: OFF", "info");
			} else {
				const sel = SELECT.enabled ? "ON" : "OFF";
				ctx.ui.notify(`Shift-select in input: ${sel}  (toggle with /select on|off)`, "info");
			}
		},
	});
}
