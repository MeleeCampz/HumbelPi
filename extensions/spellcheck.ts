/**
 * Spellcheck Extension (live highlighting)
 *
 * Replaces pi's main editor with a subclass that highlights likely typos
 * IN PLACE while you type — red + underlined, like a web form. No prompts,
 * no post-enter confirmation: the text is sent exactly as typed.
 *
 * - Dictionary : words-en.txt next to this extension file (370k words, bundled);
 *                falls back to ~/.pi/agent/extensions/words-en.txt
 * - Ignore list: ~/.pi/agent/spell-ignore.txt          (one word per line —
 *               add personal names, identifiers, project terms)
 * - Detection  : simple dictionary check — any unknown word is highlighted.
 *                (Suggestion/correction logic was deliberately dropped; may be
 *                re-added later as a separate feature.)
 * - Skipped    : slash command NAMES (the argument text after the first token IS
 *                checked), CamelCase / ALLCAPS tokens, words with digits or symbols,
 *                words ≤ 2 letters.
 * - Everywhere : also highlights free-text dialogs — createSpellcheckInputDialog()
 *                is used by ask-user.ts ("Other" answer) and guards.ts (plan feedback)
 *                instead of pi's plain ctx.ui.input.
 * - Toggle     : /spellcheck on | off | status
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomEditor, keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";

// The dictionary ships next to this extension file — works both as a loose file in
// ~/.pi/agent/extensions/ and when loaded from a pi package directory. Fall back to
// the legacy location for older layouts.
const LEGACY_EXT_DIR = path.join(os.homedir(), ".pi", "agent", "extensions");
export const WORDS_FILE = [path.join(__dirname, "words-en.txt"), path.join(LEGACY_EXT_DIR, "words-en.txt")].find((f) => fs.existsSync(f)) ?? path.join(LEGACY_EXT_DIR, "words-en.txt");
const IGNORE_FILE = path.join(os.homedir(), ".pi", "agent", "spell-ignore.txt");

// Shared state on globalThis: pi loads each extension file through jiti with
// moduleCache disabled, so a relative import of this file from another extension
// may be a SEPARATE module instance. The enabled flag and dictionary cache must
// live outside the module for /spellcheck, the main editor and the dialogs to agree.
interface SpellState { enabled: boolean; dict: Set<string> | null }
const STATE: SpellState = ((globalThis as Record<string, unknown>).__humbel_pi_spellcheck ??= { enabled: true, dict: null }) as SpellState;

function getDict(): Set<string> {
	if (STATE.dict) return STATE.dict;
	const s = new Set<string>();
	for (const f of [WORDS_FILE, IGNORE_FILE]) {
		try {
			for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
				const w = line.trim().toLowerCase();
				if (w) s.add(w);
			}
		} catch {
			/* missing file — keep going */
		}
	}
	STATE.dict = s;
	return s;
}

/** Set of words in `text` that are not in the dictionary. */
export function unknownWords(text: string, dictionary: Set<string>): Set<string> {
	const out = new Set<string>();
	const seen = new Set<string>();
	for (const m of text.matchAll(/[A-Za-z]{3,}/g)) {
		const tok = m[0];
		const lower = tok.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		if (/[A-Z]/.test(tok.slice(1))) continue; // CamelCase / ALLCAPS → identifier or acronym
		if (!dictionary.has(lower)) out.add(lower);
		if (out.size >= 40) break; // sanity cap per message
	}
	return out;
}

/** Split a rendered line into zero-width sequences and visible chars. */
interface Item {
	s: string; // the sequence or single char
	w: number; // visual width (0 for sequences)
}

function items(line: string): Item[] {
	const out: Item[] = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\x1b") {
			let j = i + 1;
			if (line[j] === "[") {
				// CSI: skip "[", consume params/intermediates (0x20-0x3f), then the
				// final byte (0x40-0x7e). "[" itself is in 0x40-0x7e, so the final-byte
				// scan must start AFTER it.
				j++;
				while (j < line.length && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x3f) j++;
				if (j < line.length) j++;
			} else if (line[j] === "]") {
				// OSC: ends with BEL or ST (ESC \)
				while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
				j += line[j] === "\x1b" ? 2 : 1;
			} else {
				j = i + 2; // F1/F2 or bare escape
			}
			out.push({ s: line.slice(i, j), w: 0 });
			i = j;
		} else {
			out.push({ s: ch, w: visibleWidth(ch) });
			i++;
		}
	}
	return out;
}

/** Plain text (all sequences removed) + visual column of each plain index. */
function plainAndCols(line: string): { plain: string; cols: number[] } {
	const its = items(line);
	let plain = "";
	const cols: number[] = [];
	let col = 0;
	for (const it of its) {
		if (it.w === 0) continue;
		cols.push(col);
		plain += it.s;
		col += it.w;
	}
	return { plain, cols };
}

/**
 * Wrap visible columns [colStart, colEnd) of a rendered (ANSI) line in an SGR
 * style. ANSI-safe: zero-width sequences inside the range (cursor inversion,
 * hardware-cursor markers, other styling) are preserved, and the style is
 * re-asserted after any of them — so ranges that contain the cursor marker
 * still get fully styled instead of being skipped or half-reset.
 */
export function styleColumnRange(line: string, colStart: number, colEnd: number, on: string, off: string): string {
	if (colEnd <= colStart) return line;
	const toks = items(line);
	let out = "";
	let col = 0;
	let styled = false;
	for (const t of toks) {
		if (t.w === 0) {
			out += t.s;
			styled = false; // the sequence may have reset SGR state — re-assert later
			continue;
		}
		const inRange = col >= colStart && col < colEnd;
		if (inRange && !styled) out += on;
		if (!inRange && styled) out += off;
		out += t.s;
		styled = inRange;
		col += t.w;
	}
	if (styled) out += off;
	return out;
}

/** Wrap flagged words in a rendered (ANSI) line with red + underline. */
export function highlightLine(line: string, bad: Set<string>): string {
	if (bad.size === 0) return line;
	const { plain, cols } = plainAndCols(line);
	let out = line;
	let lastCol = 0;
	for (const m of plain.matchAll(/[A-Za-z]{3,}/g)) {
		if (!bad.has(m[0].toLowerCase())) continue;
		const start = cols[m.index] ?? 0;
		if (start < lastCol) continue; // overlaps a previous highlight
		const end = start + visibleWidth(m[0]);
		// underline (4) + bright red (91); off = underline-off + default fg so a
		// cursor [0m reset inside the word doesn't kill the rest of it.
		out = styleColumnRange(out, start, end, "[4;91m", "[24;39m");
		lastCol = end;
	}
	return out;
}

export class SpellcheckEditor extends CustomEditor {
	private cacheText = "\u0000";
	private bad: Set<string> = new Set();

	render(width: number): string[] {
		const lines = super.render(width);
		const text = this.getText();
		if (text !== this.cacheText) {
			this.cacheText = text;
			// Slash commands: the command name is not prose, but the argument text IS
			// (e.g. /backlog <idea>, /plan on [task], /plan reject [reason]) — check it.
			const args = text.startsWith("/") ? text.slice(text.indexOf(" ") + 1) : text;
			this.bad = STATE.enabled ? unknownWords(args, getDict()) : new Set();
		}
		if (this.bad.size === 0) return lines;
		for (let i = 0; i < lines.length; i++) {
			lines[i] = highlightLine(lines[i]!, this.bad);
		}
		return lines;
	}
}

// ── Spellchecked single-line input (for dialogs) ─────────────────────────

/** pi-tui Input that highlights unknown words in place while typing. */
class SpellInput extends Input {
	private cacheText = "\u0000";
	private bad: Set<string> = new Set();

	render(width: number): string[] {
		const lines = super.render(width);
		if (!STATE.enabled) return lines;
		const text = this.getValue();
		if (text !== this.cacheText) {
			this.cacheText = text;
			this.bad = unknownWords(text, getDict());
		}
		if (this.bad.size === 0) return lines;
		for (let i = 0; i < lines.length; i++) {
			lines[i] = highlightLine(lines[i]!, this.bad);
		}
		return lines;
	}
}

/**
 * Single-line input dialog with live typo highlighting — a lookalike of pi's built-in
 * extension input (what ctx.ui.input shows) for use via ctx.ui.custom. Enter submits,
 * Esc cancels (undefined). Renders plain when spellcheck is toggled off.
 *
 * Deliberately does NOT use pi's DynamicBorder/keyHint — those read pi's internal theme
 * singleton; everything here is styled with the theme passed in by ctx.ui.custom.
 */
class SpellcheckInputDialog extends Container implements Focusable {
	private readonly input: SpellInput;
	private _focused = false;

	get focused() { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.input.focused = value; }

	constructor(
		private readonly theme: { fg(color: string, text: string): string },
		title: string,
		placeholder: string,
		private readonly done: (value: string | undefined) => void,
	) {
		super();
		this.input = new SpellInput({ placeholder });
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${this.theme.fg("dim", keyText("tui.select.confirm"))} ${this.theme.fg("muted", "submit")}  ${this.theme.fg("dim", keyText("tui.select.cancel"))} ${this.theme.fg("muted", "cancel")}`, 1, 0));
		this.addChild(new Spacer(1));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter") || data === "\n") { this.done(this.input.getValue()); return; }
		if (matchesKey(data, "escape")) { this.done(undefined); return; }
		this.input.handleInput(data);
	}

	override render(width: number): string[] {
		const border = this.theme.fg("border", "─".repeat(Math.max(4, width)));
		return [border, ...super.render(width), border];
	}

	dispose(): void {}
}

/** Factory for ctx.ui.custom — see SpellcheckInputDialog. */
export function createSpellcheckInputDialog(
	theme: { fg(color: string, text: string): string },
	title: string,
	placeholder: string,
	done: (value: string | undefined) => void,
): SpellcheckInputDialog {
	return new SpellcheckInputDialog(theme, title, placeholder, done);
}

// select-editor.ts is the single owner of the custom editor (it composes
// SpellcheckEditor). Read its flag from globalThis — NOT via an import, which
// would create a module cycle (select-editor imports this file for the class).
const selectionEnabled = (): boolean =>
	((globalThis as Record<string, unknown>).__humbel_pi_select as { enabled?: boolean } | undefined)?.enabled ?? false;

export default function (pi: ExtensionAPI) {
	const install = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new SpellcheckEditor(tui, theme, kb));
	};

	pi.on("session_start", (_event, ctx) => {
		// Only install when selection is OFF — select-editor's session_start
		// handler (idempotent, runs later in manifest order) re-applies the
		// combined choice, so both-on converges to SelectingEditor either way.
		if (STATE.enabled && !selectionEnabled()) install(ctx);
	});

	pi.registerCommand("spellcheck", {
		description: "Live typo highlighting in the editor: /spellcheck on | off | status",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			if (a === "on") {
				STATE.enabled = true;
				// When selection is ON the installed SelectingEditor reads STATE
				// live on every render — no reinstall needed.
				if (!selectionEnabled()) install(ctx);
				ctx.ui.notify("Spellcheck highlighting: ON", "info");
			} else if (a === "off") {
				STATE.enabled = false;
				// Same live-read logic; only drop the editor when selection is OFF.
				if (!selectionEnabled()) ctx.ui.setEditorComponent(undefined);
				ctx.ui.notify("Spellcheck highlighting: OFF", "info");
			} else {
				ctx.ui.notify(`Spellcheck highlighting: ${STATE.enabled ? "ON" : "OFF"}  (toggle with /spellcheck on|off)`, "info");
			}
		},
	});
}
