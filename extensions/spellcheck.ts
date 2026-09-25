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
 * - Skipped    : slash commands (/…), CamelCase / ALLCAPS tokens, words with
 *                digits or symbols, words ≤ 2 letters.
 * - Toggle     : /spellcheck on | off | status
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// The dictionary ships next to this extension file — works both as a loose file in
// ~/.pi/agent/extensions/ and when loaded from a pi package directory. Fall back to
// the legacy location for older layouts.
const LEGACY_EXT_DIR = path.join(os.homedir(), ".pi", "agent", "extensions");
export const WORDS_FILE = [path.join(__dirname, "words-en.txt"), path.join(LEGACY_EXT_DIR, "words-en.txt")].find((f) => fs.existsSync(f)) ?? path.join(LEGACY_EXT_DIR, "words-en.txt");
const IGNORE_FILE = path.join(os.homedir(), ".pi", "agent", "spell-ignore.txt");

let dict: Set<string> | null = null;

function getDict(): Set<string> {
	if (dict) return dict;
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
	dict = s;
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
				while (j < line.length && !/[@-~]/.test(line[j])) j++;
				j++;
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

/** Wrap flagged words in a rendered (ANSI) line with red + underline. */
export function highlightLine(line: string, bad: Set<string>): string {
	if (bad.size === 0) return line;
	const its = items(line);
	const { plain, cols } = plainAndCols(line);
	let out = "";
	let lastCol = 0;
	let changed = false;
	for (const m of plain.matchAll(/[A-Za-z]{3,}/g)) {
		if (!bad.has(m[0].toLowerCase())) continue;
		const start = cols[m.index] ?? 0;
		if (start < lastCol) continue; // overlaps a previous highlight
		const end = start + visibleWidth(m[0]);
		// Segment must be pure visible chars (no cursor marker / styling inside).
		let seg = "";
		let col = 0;
		for (const it of its) {
			if (it.w === 0) continue;
			if (col >= start && col < end) seg += it.s;
			col += it.w;
		}
		if (seg.length !== m[0].length) continue; // interrupted by a sequence — skip
		// Prefix: items in [lastCol, start), sequences preserved.
		let prefix = "";
		col = 0;
		for (const it of its) {
			if (col >= start) break;
			if (col >= lastCol) prefix += it.s;
			col += it.w;
		}
		// underline (4) + bright red (91) — light/whitish red, easy to see
		out += prefix + "\x1b[4;91m" + seg + "\x1b[0m";
		lastCol = end;
		changed = true;
	}
	if (!changed) return line;
	// Suffix: everything from lastCol on.
	let suffix = "";
	let col = 0;
	for (const it of its) {
		if (col >= lastCol) suffix += it.s;
		col += it.w;
	}
	return out + suffix;
}

class SpellcheckEditor extends CustomEditor {
	private cacheText = "\u0000";
	private bad: Set<string> = new Set();

	render(width: number): string[] {
		const lines = super.render(width);
		const text = this.getText();
		if (text !== this.cacheText) {
			this.cacheText = text;
			this.bad = text.startsWith("/") ? new Set() : unknownWords(text, getDict());
		}
		if (this.bad.size === 0) return lines;
		for (let i = 0; i < lines.length; i++) {
			lines[i] = highlightLine(lines[i]!, this.bad);
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	const install = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new SpellcheckEditor(tui, theme, kb));
	};

	pi.on("session_start", (_event, ctx) => {
		if (enabled) install(ctx);
	});

	pi.registerCommand("spellcheck", {
		description: "Live typo highlighting in the editor: /spellcheck on | off | status",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			if (a === "on") {
				enabled = true;
				install(ctx);
				ctx.ui.notify("Spellcheck highlighting: ON", "info");
			} else if (a === "off") {
				enabled = false;
				ctx.ui.setEditorComponent(undefined);
				ctx.ui.notify("Spellcheck highlighting: OFF", "info");
			} else {
				ctx.ui.notify(`Spellcheck highlighting: ${enabled ? "ON" : "OFF"}  (toggle with /spellcheck on|off)`, "info");
			}
		},
	});
}
