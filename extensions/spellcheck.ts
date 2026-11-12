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
 * - Everywhere : also highlights free-text dialogs — the answer box used by ask_user's "Other"
 *                and the plan feedback box lives in lib/dialog-input.ts (ask-flow.ts builds it),
 *                and this file hands it its dictionary, pi's submit-key label and the clipboard
 *                writer through the seams at the bottom of this header. Those dialogs use Enter
 *                submit / Esc back to the options / Ctrl+C cancel — see ask-loop.ts.
 * - Toggle     : /spellcheck on | off | status
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomEditor, copyToClipboard, keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightLine } from "./lib/ansi-style";
import { unknownWords } from "./lib/spell-words";
// #9: the shared /select switch (owned by select-editor.ts on globalThis) and, through
// lib/dialog-input.ts, the Shift-selection behavior of the free-text dialogs. The key
// classification table itself lives in lib/shift-moves.ts, shared with the main editor so the
// two hosts measure the same bytes and cannot drift into different key semantics.
import { setClipboardWriter, setDialogNotifier, setDialogSpellPaint, setSubmitKeyLabel } from "./lib/dialog-input";
import { selectionEnabled } from "./lib/shift-moves";

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


// ── Seams: what this extension hands the pure dialog module ───────────────────
//
// lib/dialog-input.ts is pi-tui-only on purpose (so a regression test can drive real keystrokes
// through the answer box). Everything that needs pi-coding-agent — the dictionary, pi's keybinding
// label, the clipboard writer — is pushed in here, at module load, which happens before any dialog
// can open. Order does not matter between the extensions; only that this file is loaded at all, and
// it is: it is the extension entry listed in package.json.
setDialogSpellPaint({
	enabled: () => STATE.enabled,
	// The typo rule is the SAME one the main editor uses (unknownWords) — the dialog must not get a
	// looser or stricter dictionary than the editor, or the same word is flagged in one place only.
	badWords: (text: string) => unknownWords(text, getDict()),
});
try {
	// The hint line names the submit key from pi's own keybinding table, so a user who rebound
	// submit sees their key. Guarded: a broken keybinding lookup must not take the whole extension down.
	setSubmitKeyLabel(keyText("tui.select.confirm"));
} catch { /* keep the module default ("enter") */ }
// Copy keys route through pi's clipboard path (OSC 52 under an SSH session, native clipboard
// locally). Tests replace this writer to prove the routing without touching the real clipboard.
setClipboardWriter(copyToClipboard);

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
			// #8: no space yet → there is nothing after the command name → check
			// nothing (slice(0) used to leak the "/cmd" prefix itself into the check).
			const sp = text.indexOf(" ");
			const args = text.startsWith("/") ? (sp === -1 ? "" : text.slice(sp + 1)) : text;
			this.bad = STATE.enabled ? unknownWords(args, getDict()) : new Set();
		}
		if (this.bad.size === 0) return lines;
		for (let i = 0; i < lines.length; i++) {
			lines[i] = highlightLine(lines[i]!, this.bad);
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const install = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new SpellcheckEditor(tui, theme, kb));
	};

	pi.on("session_start", (_event, ctx) => {
		// #9: the dialog input reports clipboard results but is a Component, not a command handler —
		// it has no ctx of its own, so the notify() reaches it through here (select-editor #14 pattern).
		setDialogNotifier((msg: string) => ctx.ui.notify(msg, "info"));
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
