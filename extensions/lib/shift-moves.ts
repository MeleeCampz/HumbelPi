/**
 * shift-moves — the pure key classification shared by every place HumbelPi turns
 * pi's DEAD Shift+arrows into text selection (backlog #10 main editor, #9-pass dialog
 * inputs). Extracted from select-editor.ts so the main editor and the free-text dialogs
 * cannot drift apart: they measure the same bytes and they must mean the same thing.
 *
 * What the wire actually sends, measured against pi-tui (pi 1.5.2, real Input instances):
 *   Shift+Left/Right/Up/Down/Home/End  → ESC [ 1 ; 2 [A-F|H|F]   pi-tui: no binding matches,
 *                                        the sequence is rejected by Input's control-character
 *                                        guard → the keystroke is silently SWALLOWED (this is
 *                                        the whole "shift select does nothing" complaint).
 *   Ctrl+Left/Right                   → ESC [ 1 ; 5 [CD]         pi-tui Input DOES act on this:
 *                                        the caret jumps a word.
 *   Ctrl+Shift+Left/Right              → ESC [ 1 ; 6 [CD]         NOTHING acts on it. matchesKey
 *                                        recognizes "ctrl+shift+left", but Input has no binding for
 *                                        it and the sequence never reaches keypress() (measured:
 *                                        the caret does not move). There is no built-in word
 *                                        selection to reuse — so the canonical fed to the engine is
 *                                        the CTRL-only form, which is the same word motion, and the
 *                                        Shift part is re-expressed by this module moving the
 *                                        selection endpoint.
 *   Kitty CSI-u Shift+Left             → ESC [ 8592 ; 2 u         pi-tui's decodeKittyPrintable
 *                                        decodes 8592 (←) as a PRINTABLE character and inserts a
 *                                        literal "←" into the text. Selecting mode must match the
 *                                        key before that happens.
 * So: always feed the engine a CANONICAL sequence it demonstrably acts on (plain arrows, plain
 * ctrl+arrows), never the raw modified form — the raw forms are either swallowed or inserted as
 * text. Selection is then derived from where the caret lands.
 *
 * Plain helper module: pi-tui key helpers only, registers nothing (importable from tests).
 */
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

/**
 * Shift-movement key → the sequence pi's own engine demonstrably acts on. The ctrl+shift entries
 * deliberately map to the CTRL-only arrow: the engine has no ctrl+shift binding, but ctrl+left is
 * word motion — the Shift part is this module's job (extend the selection endpoint), not the
 * terminal's.
 */
const SHIFT_MOVES: Array<[KeyId, string]> = [
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
 * Raw-sequence fallback (the reference implementation found matchesKey unreliable in some
 * environments). Covers the modified-arrow form ESC[1;mX and kitty CSI-u.
 * Wire modifier encoding (per pi's own parser, keys.js parseKittySequence): bitmask =
 * wireValue - 1, with shift = bit 0 — so Shift is present when ((m - 1) & 1) !== 0
 * (wire 2=shift, 3=alt, 4=shift+alt…).
 */
const RAW_SHIFT_ARROW = /^\x1b\[(\d+);(\d+)([ABCDHF])$/;
const RAW_KITTY_SHIFT_MOVE = /^\x1b\[(8592|8593|8594|8595|8963|8964);(\d+)u$/;
const KITTY_MOVE_SEQ: Record<string, string> = {
	"8592": "\x1b[D", "8594": "\x1b[C", "8593": "\x1b[A", "8595": "\x1b[B",
	"8963": "\x1b[H", "8964": "\x1b[F",
};
/**
 * Kitty CSI-u Insert (pi-tui's own table maps codepoint 57425 → insert, so Shift+Insert arrives
 * as ESC[57425;2u). Deliberately NOT 8677: measured against pi-tui, U+21E5 (⇥) is the SHIFTED
 * GLYPH OF TAB (ESC[9:8677;2u matches shift+tab), so matching it here would steal Shift+Tab and
 * call it a copy. U+21E7 (⇧, the shift symbol) is a printable too — no terminal reports Insert
 * as a symbol glyph.
 */
const RAW_KITTY_SHIFT_INSERT = /^\x1b\[(57425);(\d+)u$/;
/**
 * The other copy-key spellings, raw. Added after .pi/press scenario q measured the failure mode:
 * the sequences arrive at handleInput BYTE FOR BYTE (proved by the dialog's key log), the selection
 * is live, and still nothing copies — because matchesKey answers differently inside a running pi
 * than it does in a standalone probe. A key-copy feature may not depend on that flip-flop, so every
 * spelling gets the same raw treatment the arrows already had.
 */
const RAW_XTERM_SHIFT_INSERT = /^\x1b\[2;(\d+)~$/; // Insert + wire modifier (Shift+Insert)
const RAW_KITTY_CTRL_SHIFT_C = /^\x1b\[(99);(\d+)u$/; // 'c' + modifier in kitty CSI-u
const RAW_MODKEYS_CTRL_SHIFT_C = /^\x1b\[27;(\d+);99~$/; // same key in modifyOtherKeys

const PLAIN_ARROW: Record<string, string> = {
	D: "\x1b[D", C: "\x1b[C", A: "\x1b[A", B: "\x1b[B", H: "\x1b[H", F: "\x1b[F",
};

export const hasShiftWireMod = (wireMod: string): boolean => ((parseInt(wireMod, 10) - 1) & 1) !== 0;
export const hasCtrlWireMod = (wireMod: string): boolean => ((parseInt(wireMod, 10) - 1) & 4) !== 0;

/**
 * The canonical sequence to hand to pi's movement engine for a shift-movement key,
 * or null when `data` is not one. Ctrl+Shift+Left/Right become a word jump (the ctrl-only form).
 */
export function matchShiftMove(data: string): string | null {
	for (const [key, seq] of SHIFT_MOVES) if (matchesKey(data, key)) return seq;
	let m = RAW_SHIFT_ARROW.exec(data);
	if (m && hasShiftWireMod(m[2]!)) {
		// Ctrl bit + left/right → word jump (shift+ctrl+arrow extends the selection by words
		// even when matchesKey is unreliable).
		if (hasCtrlWireMod(m[2]!) && (m[3] === "D" || m[3] === "C")) {
			return m[3] === "D" ? "\x1b[1;5D" : "\x1b[1;5C";
		}
		return PLAIN_ARROW[m[3]!] ?? null;
	}
	m = RAW_KITTY_SHIFT_MOVE.exec(data);
	if (m && hasShiftWireMod(m[2]!)) {
		// Ctrl+Shift+Left/Right over kitty (ESC[8592;6u) is a WORD move — same canonical as the
		// xterm form above. Without the ctrl check it degrades to a one-character selection.
		if (hasCtrlWireMod(m[2]!) && (m[1] === "8592" || m[1] === "8594")) {
			return m[1] === "8592" ? "\x1b[1;5D" : "\x1b[1;5C";
		}
		return KITTY_MOVE_SEQ[m[1]!] ?? null;
	}
	return null;
}

/** Copy-while-selected keys that are unambiguous (Ctrl+C is NOT one of these — see below). */
export function isCopyKey(data: string): boolean {
	if (matchesKey(data, "shift+insert") || matchesKey(data, "ctrl+shift+c")) return true;
	// Raw fallbacks, deliberately the same policy matchShiftMove already uses: matchesKey is known to
	// be unreliable in some environments (and provably inconsistent between a running pi and a probe).
	// Which bits the wire modifier carries is arithmetic, not a lookup.
	let m = isRawShiftInsert(data);
	if (m) return true;
	const x = RAW_XTERM_SHIFT_INSERT.exec(data);
	if (x && hasShiftWireMod(x[1]!)) return true;
	const k = RAW_KITTY_CTRL_SHIFT_C.exec(data);
	if (k && hasShiftWireMod(k[2]!) && hasCtrlWireMod(k[2]!)) return true;
	const o = RAW_MODKEYS_CTRL_SHIFT_C.exec(data);
	return !!o && hasShiftWireMod(o[1]!) && hasCtrlWireMod(o[1]!);
}

export function isRawShiftInsert(data: string): boolean {
	const m = RAW_KITTY_SHIFT_INSERT.exec(data);
	return !!m && hasShiftWireMod(m[2]!);
}

/** Ctrl+C (the plain control byte included — some terminals send that form). */
export function isCtrlC(data: string): boolean {
	return matchesKey(data, "ctrl+c") || data === "\u0003";
}

/**
 * Ctrl+A — select all. pi stock binds ctrl+a to line-start; selecting mode repurposes it
 * (reference impl). Raw \x01 covers terminals that send the plain control byte.
 */
export function isSelectAllKey(data: string): boolean {
	return matchesKey(data, "ctrl+a") || data === "\u0001";
}

/** Keys that EDIT text in place: Backspace / Delete / a single printable character. */
export function isEditingKey(data: string): boolean {
	if (matchesKey(data, "backspace") || matchesKey(data, "delete")) return true;
	// Single printable code point (astral-safe: emoji are 2 UTF-16 units).
	const cps = [...data];
	return cps.length === 1 && cps[0]!.charCodeAt(0) >= 32;
}

export type MoveEdge = "start" | "end";

/**
 * A plain (unmodified) movement key and which selection edge it collapses to.
 * `multiline: false` (the single-line dialog input) leaves Up/Down out entirely — pi's Input
 * has no line movement, so treating them as "start/end" would move the caret for no reason.
 */
export function plainMoveEdge(data: string, o: { multiline: boolean }): MoveEdge | undefined {
	if (matchesKey(data, "left") || matchesKey(data, "home") || (o.multiline && matchesKey(data, "up"))) return "start";
	if (matchesKey(data, "right") || matchesKey(data, "end") || (o.multiline && matchesKey(data, "down"))) return "end";
	return undefined;
}

/**
 * Is Shift selection switched on? The flag itself lives on globalThis and is OWNED by
 * select-editor.ts (the extension that also owns the custom editor and the /select command); this
 * reader is shared so the main editor, the dialog inputs and the spellcheck installer all answer
 * from one switch. Read from globalThis rather than imported: a jiti double-instance would give a
 * second copy of any module-level flag, and then /select on would silence the squiggles without
 * moving a single selection.
 */
export const selectionEnabled = (): boolean =>
	((globalThis as Record<string, unknown>).__humbel_pi_select as { enabled?: boolean } | undefined)?.enabled ?? false;
