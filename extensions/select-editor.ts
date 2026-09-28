/**
 * Select-Editor Extension (shift-based text selection in the input)
 *
 * Turns pi's DEAD Shift+arrow keys into standard text selection in the main
 * input editor, with copy to the system clipboard. Research-backed design —
 * see the approved plan for backlog #3.
 *
 * How it works
 * - SelectingEditor extends SpellcheckEditor (so typo highlighting keeps
 *   working) and overrides handleInput/render only.
 * - Shift+Left/Right/Up/Down/Home/End (+ Ctrl+Shift word jumps) set a
 *   document-coordinate anchor, then synthesize the PLAIN movement sequence
 *   into super.handleInput() so pi's own grapheme-aware engine moves the caret.
 * - Plain arrows with an active selection collapse to the edge in the pressed
 *   direction (reference-impl policy); any other key clears the selection.
 * - Copy: Shift+Insert, Ctrl+Shift+C, or Ctrl+C while a non-collapsed
 *   selection exists (consumed — without a selection Ctrl+C falls through to
 *   pi's clear/exit, so double-Ctrl+C-to-exit is preserved). Uses pi's own
 *   exported copyToClipboard() (native → WSL interop → OSC 52).
 * - Feedback: "⬒ N" indicator on the editor's bottom border.
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
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SpellcheckEditor } from "./spellcheck";
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
const RAW_KITTY_SHIFT_ARROW = /^\x1b\[(8592|8593|8594|8595);(\d+)u$/;
const KITTY_ARROW_SEQ: Record<string, string> = { "8592": "\x1b[D", "8594": "\x1b[C", "8593": "\x1b[A", "8595": "\x1b[B" };

const hasShiftWireMod = (wireMod: string): boolean => ((parseInt(wireMod, 10) - 1) & 1) !== 0;

function matchShiftMove(data: string): string | null {
	for (const [key, seq] of SHIFT_MOVES) if (matchesKey(data, key)) return seq;
	let m = RAW_SHIFT_ARROW.exec(data);
	if (m && hasShiftWireMod(m[2])) {
		const plain: Record<string, string> = { D: "\x1b[D", C: "\x1b[C", A: "\x1b[A", B: "\x1b[B", H: "\x1b[H", F: "\x1b[F" };
		return plain[m[3]] ?? null;
	}
	m = RAW_KITTY_SHIFT_ARROW.exec(data);
	if (m && hasShiftWireMod(m[2])) return KITTY_ARROW_SEQ[m[1]] ?? null;
	return null;
}

// ── Editor ────────────────────────────────────────────────────────────────

interface DocPos { line: number; col: number }

class SelectingEditor extends SpellcheckEditor {
	private anchor: DocPos | null = null;

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

	private hasSelection(): boolean {
		const a = this.anchor, c = this.caretPos();
		return !!(a && c && (a.line !== c.line || a.col !== c.col));
	}

	/** Selected text in document order, or null when no/collapsed selection. */
	getSelectedText(): string | null {
		const a = this.anchor, c = this.caretPos();
		if (!a || !c) return null;
		if (a.line === c.line && a.col === c.col) return null;
		const st = (this as unknown as { state?: { lines: string[] } }).state;
		if (!st) return null;
		const startFirst = a.line < c.line || (a.line === c.line && a.col <= c.col);
		const s = startFirst ? a : c, e = startFirst ? c : a;
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

	override handleInput(data: string): void {
		// Copy keys — only with a live selection.
		if (this.hasSelection()) {
			const text = this.getSelectedText();
			if (text !== null && (matchesKey(data, "shift+insert") || matchesKey(data, "ctrl+shift+c"))) {
				void this.copySelected(text);
				return;
			}
			// Ctrl+C with an active selection copies and is consumed; without a
			// selection it falls through to pi's clear/exit (double-Ctrl+C preserved).
			if (matchesKey(data, "ctrl+c")) {
				void this.copySelected(text);
				return;
			}
		}

		// Shift-movement: start the selection, then let pi move the caret.
		const plain = matchShiftMove(data);
		if (plain !== null) {
			if (!this.anchor) this.anchor = this.caretPos();
			super.handleInput(plain);
			return;
		}

		// Any other key: clear the selection first…
		if (this.anchor !== null) {
			const a = this.anchor;
			this.anchor = null;
			const c = this.caretPos();
			// …but a plain arrow collapses to the edge in the pressed direction
			// and consumes the key (reference-impl policy).
			if (c) {
				const dirLeft = matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "home");
				const dirRight = matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "end");
				if (dirLeft || dirRight) {
					const startFirst = a.line < c.line || (a.line === c.line && a.col <= c.col);
					const start = startFirst ? a : c, end = startFirst ? c : a;
					this.setCaret(dirLeft ? start : end);
					return;
				}
			}
		}

		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width); // base + spellcheck layer
		if (lines.length === 0) return lines;
		const text = this.getSelectedText();
		if (text !== null) {
			const label = ` \u2B12 ${[...text].length} `;
			const last = lines.length - 1;
			if (visibleWidth(lines[last]!) >= label.length) {
				lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
			}
		}
		return lines;
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
				ctx.ui.notify("Shift-select in input: ON  (shift+arrows select · shift+insert / ctrl+shift+c / ctrl+c copy)", "info");
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
