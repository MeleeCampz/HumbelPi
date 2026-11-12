/**
 * ansi-style — pure ANSI-aware line styling helpers (no pi, no state, no dictionary).
 *
 * Why this is its own module: three hosts need the SAME column arithmetic — the main editor
 * (select-editor.ts), the dialog inputs (lib/dialog-input.ts) and the spellcheck editor
 * (spellcheck.ts). Column math on a rendered line is the part that goes subtly wrong (a
 * highlight landing on the wrong character, a style leaking to end-of-line), and it is
 * invisible in a review. One implementation, importable from tests, is the whole point.
 *
 * The tokenizer treats every escape sequence as ONE zero-width token, including pi's hardware
 * cursor marker (an APC sequence "\\x1b_pi:c\\x07") which pi strips by exact match before
 * writing — splitting it would leak a BEL (terminal beep) and the literal text "pi:c".
 */

import { visibleWidth } from "@earendil-works/pi-tui";


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
			} else if (line[j] === "_") {
				// APC (e.g. pi's CURSOR_MARKER "\x1b_pi:c\x07"): ends with BEL or ST.
				// MUST stay one atomic token — pi strips it by exact indexOf before
				// writing, so splitting it leaks a raw BEL (terminal bell) and the
				// embedded "pi:c" text to the screen.
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
 * The sequence-free text of a rendered line, using the SAME token walk as the styler.
 * A naive regex strip is what hides bugs here: it leaves pi's cursor markers (two different APC
 * sequences, start and end) as visible junk like "_pi:/fc" and a BEL, so "how wide is this line"
 * measures the wrong thing. Anyone counting columns or comparing rendered text needs this.
 */
export function plainText(line: string): string {
	return plainAndCols(line).plain;
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
			// Close the range BEFORE the sequence: if it sits at the range end,
			// dropping the closing SGR would leak the style to end-of-line.
			if (styled) out += off;
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

/**
 * Truncate a rendered (ANSI) line to at most maxCols VISIBLE columns, cutting
 * only on character boundaries — never inside an escape sequence. Escape
 * sequences are dropped (pi's truncateToWidth counts their bytes as visible
 * width and slices by char index, which corrupts styled lines).
 */
export function truncateAnsi(line: string, maxCols: number): string {
	if (maxCols <= 0) return "";
	let out = "";
	let col = 0;
	for (const t of items(line)) {
		if (t.w === 0) continue; // drop sequences — never emit dangling styles
		if (col + t.w > maxCols) break;
		out += t.s;
		col += t.w;
	}
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

/**
 * The selection style pair, shared by both hosts (main editor + dialog inputs) so the same gesture
 * looks identical everywhere. A dark gray BACKGROUND, deliberately NOT reverse video: pi-tui renders
 * its fake cursor with `renderFakeCursor`, which IS reverse video (ESC[7m), so a selection styled
 * 7/27 is indistinguishable from the caret character — and any measurement of "which columns got
 * painted" silently measures the cursor instead of the selection.
 */
export const SELECTION_ON = "\x1b[48;5;236m";
export const SELECTION_OFF = "\x1b[49m";
