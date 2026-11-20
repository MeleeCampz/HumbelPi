/**
 * plan-view — the /plan overlay editor for CONSOLE plan mode (backlog #16).
 *
 * This is the "stay inside the TUI" half of console plan mode: the plan is not a file you open in
 * an editor, it is this component. It is shown through ctx.ui.custom() (the same host the backlog
 * checklist uses) and it edits the authoritative plan in the session-state file.
 *
 * WHY EDITS COMMIT AS OPS AND THIS COMPONENT HOLDS NO COPY OF THE PLAN:
 * the agent is drafting into the SAME plan while this overlay is open, and a plan_doc call can
 * land between two of your keystrokes. So the component asks the host for the current document on
 * every render (host.getDoc) and sends OPERATIONS (host.apply), never whole documents. Two
 * documents racing to be "the latest one" is how a live edit silently deletes the model's new
 * step; an op applied against whatever is current is not.
 *
 * The cursor is stored as a STEP ID, not an index (plan-doc ids are stable and never reused), so a
 * concurrent add/reorder/remove underneath the cursor cannot move it onto a different step.
 *
 * WHY DELETE IS TWO STEPS (drop, then remove): "step 3 is out" is a planning decision both sides
 * can still see; a hard delete is gone. Dropping costs one keypress, removing costs dropping
 * first — so one stray keystroke never erases rows you were mid-way through reading.
 *
 * pi-tui-only imports (plus the pure ./plan-doc model and the shared SelectingInput): the same
 * rule as dialog-input.ts, so tools/test-plan-view.ts can drive this with real keystrokes without
 * the extension graph. `theme` and the state host enter as parameters.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, Markdown, type Component, type Focusable, type MarkdownTheme } from "@earendil-works/pi-tui";
import { SelectingInput } from "./dialog-input";
import {
	STATUS_COLOR,
	STATUS_GLYPH,
	planProgress,
	type PlanDoc,
	type PlanNoteKind,
	type PlanOp,
	type PlanOpResult,
	type PlanProgress,
	type PlanStep,
} from "./plan-doc";

export type PlanSection = "steps" | "brief" | "decisions" | "constraints" | "open";
export const SECTION_ORDER: PlanSection[] = ["steps", "brief", "decisions", "constraints", "open"];
export const SECTION_LABEL: Record<PlanSection, string> = {
	steps: "Steps",
	brief: "Brief",
	decisions: "Decisions",
	constraints: "Constraints",
	open: "Open questions",
};
/** #23: the same bar when the terminal is too narrow for the long names (see render). */
export const SECTION_SHORT: Record<PlanSection, string> = {
	steps: "Steps",
	brief: "Brief",
	decisions: "Dec",
	constraints: "Cons",
	open: "Open",
};
/**
 * A run of brief source lines that markdown must render TOGETHER. The brief's cursor points at one
 * SOURCE line, but the body is rendered (a table line becomes three box-drawing rows, a fence becomes
 * its own block), so "which row is my line on?" is only answerable if the document is cut into pieces
 * that each render independently. A block is the smallest such piece: a fenced code block, one table,
 * one list run, or a single line. Blank lines are blocks too — an empty line is still a line you can
 * put the cursor on, edit, or delete twice.
 */
export interface BriefBlock {
	/** inclusive index into the brief's source line list */
	start: number;
	end: number;
}

const BRIEF_FENCE = /^\s{0,3}(```|~~~|`{4,}|~{4,})/;
const BRIEF_TABLE_ROW = (l: string): boolean => l.trimStart().startsWith("|");
const BRIEF_LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s/;
/** indented continuation of the list item above it */
const BRIEF_LIST_CONT = /^\s{2,}\S/;

export function briefBlocksOf(lines: string[]): BriefBlock[] {
	const out: BriefBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		const l = lines[i];
		if (!l.trim()) { out.push({ start: i, end: i }); i++; continue; }
		if (BRIEF_FENCE.test(l)) {
			// A fence runs to its closing fence (or the end of the document). Everything inside it is
			// rendered verbatim by markdown, including a line that looks like a table or a list item —
			// grouping anything else into a fence would say "your cursor is on line 7" while markdown
			// was drawing line 7 as code.
			let j = i + 1;
			while (j < lines.length && !BRIEF_FENCE.test(lines[j])) j++;
			const end = Math.min(j, lines.length - 1);
			out.push({ start: i, end });
			i = end + 1;
			continue;
		}
		if (BRIEF_TABLE_ROW(l)) {
			let j = i;
			while (j < lines.length && BRIEF_TABLE_ROW(lines[j])) j++;
			out.push({ start: i, end: j - 1 });
			i = j;
			continue;
		}
		if (BRIEF_LIST_ITEM.test(l)) {
			let j = i;
			while (j < lines.length && (BRIEF_LIST_ITEM.test(lines[j]) || BRIEF_LIST_CONT.test(lines[j]))) j++;
			out.push({ start: i, end: j - 1 });
			i = j;
			continue;
		}
		// Paragraph lines each get their own block. Markdown would join them into one paragraph, so a
		// joined run could not say which of its rendered rows your line became — and the whole point of
		// the ruler is that the number on the row is the line `⏎` will edit.
		out.push({ start: i, end: i });
		i++;
	}
	return out;
}

/** Only the three NOTE sections are backed by a plan-doc note list; steps and the brief are not. */
const SECTION_NOTE_KIND: Partial<Record<PlanSection, PlanNoteKind>> = {
	decisions: "decision",
	constraints: "constraint",
	open: "open",
};

/** The host owns the state (session-state JSON) and the notification surface. */
export interface PlanEditorHost {
	/** Fresh read of the authoritative plan (null = nothing planned any more). */
	getDoc(): PlanDoc | null;
	/** Commit one operation to the authoritative plan. The component never writes a whole document. */
	apply(op: PlanOp): PlanOpResult;
	notify?(message: string): void;
}

export interface PlanEditorClose {
	/** Ops the user applied while the overlay was open (0 = they only looked). */
	edits: number;
	/** One line per applied edit — this becomes the steer the model is given on close. */
	summary: string[];
}

export interface PlanEditorTheme {
	fg(color: string, text: string): string;
	/** pi's real theme has these; the keystroke tests pass a stub with only `fg`, so every extra is optional
	 *  and every use has a fallback. That is also what keeps the markdown renderer testable without pi. */
	style?(text: string, options: { fg?: string; bg?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; dim?: boolean }): string;
	bold?(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
	strikethrough?(text: string): string;
	highlight?(code: string, lang: string | undefined): readonly string[];
}

/**
 * #23: pi's own markdown theme, built from the theme this host was handed.
 *
 * WHY NOT import { getMarkdownTheme } from pi: that is pi's private module graph, and this file is the
 * pi-tui-only half of the plan (the rule that lets tools/test-plan-view.ts drive it with real keystrokes
 * and nothing else). The tokens used here are the ones already proven in these extensions — "accent",
 * "muted", "dim", "text", "warning", "success" — because pi 1.5.2 rejects an unknown role outright.
 */
export function planMarkdownTheme(theme: PlanEditorTheme): MarkdownTheme {
	const styled = (text: string, color: string, bold = false): string =>
		theme.style
			? theme.style(text, { fg: color, ...(bold ? { bold: true } : {}) })
			: bold && theme.bold ? theme.bold(theme.fg(color, text)) : theme.fg(color, text);
	return {
		heading: (t) => styled(t, "accent", true),
		link: (t) => styled(t, "accent"),
		linkUrl: (t) => theme.fg("muted", t),
		code: (t) => theme.fg("text", t),
		codeBlock: (t) => theme.fg("text", t),
		codeBlockBorder: (t) => theme.fg("muted", t),
		quote: (t) => theme.fg("muted", t),
		quoteBorder: (t) => theme.fg("muted", t),
		hr: (t) => theme.fg("muted", t),
		listBullet: (t) => theme.fg("accent", t),
		bold: (t) => (theme.bold ? theme.bold(t) : t),
		italic: (t) => (theme.italic ? theme.italic(t) : t),
		underline: (t) => (theme.underline ? theme.underline(t) : t),
		strikethrough: (t) => (theme.strikethrough ? theme.strikethrough(t) : t),
		highlightCode: theme.highlight ? (code, lang) => [...theme.highlight!(code, lang)] : undefined,
	};
}

/** What the cursor is on: a step (by stable id), a note in the current section (by position), or a
 *  SOURCE LINE of the brief (by position — the rendered body is wrapped, so it has no row-per-line map). */
type Target = { kind: "step"; id: number } | { kind: "note"; index: number } | { kind: "briefLine"; index: number };

const EMPTY_PROGRESS: PlanProgress = { total: 0, done: 0, open: 0, doing: 0, dropped: 0, remaining: [], allDone: false };

/** What the overlay is, typed the way its callers use it: pi's Component has handleInput optional
 * (components may be display-only), but this one always handles keys — a host should not have to
 * write `?.` around every keystroke it forwards. */
export type PlanEditorComponent = Component & Focusable & { handleInput(data: string): void };

export function createPlanEditor(
	host: PlanEditorHost,
	theme: PlanEditorTheme,
	done: (result: PlanEditorClose) => void,
	options: { section?: PlanSection; wrap?: boolean; readOnly?: boolean } = {},
): PlanEditorComponent {
	let section: PlanSection = options.section ?? "steps";
	// #22: a VIEWER, not an editor — used for the retired plan. Every mutation is refused at the one
	// choke point (apply) AND at the keys, so a viewer cannot half-work: the header and the hint line
	// say so too, because a read-only editor that looks editable is worse than no editor.
	const readOnly = options.readOnly === true;
	const readOnlyKey = (): void => {
		lastLog = "read-only — this plan is finished and kept for reference. /plan export last [file] saves a copy of it.";
	};
	// #17: expanded by DEFAULT here — you opened this overlay to read the plan, and a step truncated
	// at the terminal width is the complaint. `w` flips it; the live panel keeps the opposite default
	// (its budget is a third of the terminal) and is set with /plan wrap.
	let wrapRows = options.wrap ?? true;
	let stepCursor: number | null = null; // steps: by ID
	let noteCursor = 0;                   // notes: by position (they have no ids)
	let briefCursor = 0;                  // #23: the brief: by source-line position
	// #15 (the delete-safety call): a Brief line has no status to drop first, so a step's "D drops, D removes"
	// trick cannot protect it. The protection is an ARM: the first D marks one line under the cursor and says
	// so on that line; the second D deletes it. It lives here, in overlay state, not as a new PlanOp — the
	// model's one brief op stays a single whole-body write, and plan-doc.ts stays import-free.
	let armedBrief: number | null = null;
	let editing: Target | null = null;
	let draft: SelectingInput | null = null;
	let focused = false;
	const applied: string[] = [];
	let lastLog: string | null = null;

	// ── the editing box: the shared dialog input, so Shift selection works here exactly as it
	//    does in the ask_user / plan-feedback boxes (backlog #9).
	const openEditor = (initial: string, placeholder: string): void => {
		const box = new SelectingInput({ placeholder });
		// Draft through the bracketed-paste path: Input.setValue() clamps the caret to position 0,
		// which would put the next typed character IN FRONT of the current text (dialog-input.ts,
		// same fix as the plan-feedback box).
		if (initial) box.handleInput(`\x1b[200~${initial}\x1b[201~`);
		box.focused = focused;
		draft = box;
	};
	const closeEditor = (): void => { editing = null; draft = null; };

	// ── the document is always the host's, read fresh ────────────────────────
	const doc = (): PlanDoc | null => host.getDoc();
	const stepsOf = (d: PlanDoc | null): PlanStep[] => (d ? d.steps : []);
	const notesOf = (d: PlanDoc | null, s: PlanSection): string[] =>
		!d ? [] : s === "decisions" ? d.decisions : s === "constraints" ? d.constraints : s === "open" ? d.openQuestions : [];
	/** #23: the brief as SOURCE lines (that is what a line cursor and a line edit operate on). */
	const briefLinesOf = (d: PlanDoc | null): string[] => (d?.brief ?? "").split("\n");

	/** Clamp the cursor into the current list, healing a cursor whose step was removed underneath it. */
	const targetList = (d: PlanDoc | null): Target | null => {
		if (section === "steps") {
			const st = stepsOf(d);
			if (st.length === 0) { stepCursor = null; return null; }
			if (stepCursor === null || !st.some((s) => s.id === stepCursor)) stepCursor = st[0]!.id;
			return { kind: "step", id: stepCursor };
		}
		if (section === "brief") {
			const lines = briefLinesOf(d);
			if (lines.length === 0 || (lines.length === 1 && !lines[0]!.trim())) { briefCursor = 0; return null; }
			briefCursor = Math.min(Math.max(0, briefCursor), lines.length - 1);
			return { kind: "briefLine", index: briefCursor };
		}
		const n = notesOf(d, section).length;
		if (n === 0) { noteCursor = 0; return null; }
		noteCursor = Math.min(Math.max(0, noteCursor), n - 1);
		return { kind: "note", index: noteCursor };
	};

	const hoveredStep = (d: PlanDoc | null): PlanStep | null => {
		if (section !== "steps") return null;
		const t = targetList(d);
		return t && t.kind === "step" ? stepsOf(d).find((s) => s.id === t.id) ?? null : null;
	};

	const apply = (op: PlanOp): boolean => {
		// #22: the single choke point. Nothing in this component writes the plan except through apply().
		if (readOnly) { readOnlyKey(); return false; }
		const res = host.apply(op);
		lastLog = res.ok ? res.log : `✗ ${res.log}`;
		if (!res.ok) { host.notify?.(`Plan edit refused: ${res.log}`); return false; }
		applied.push(res.log);
		return true;
	};

	// ── key actions ──────────────────────────────────────────────────────────
	const move = (delta: number): void => {
		const d = doc();
		if (section === "steps") {
			const st = stepsOf(d);
			if (!st.length) return;
			const at = st.findIndex((s) => s.id === stepCursor);
			const next = Math.min(st.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta));
			stepCursor = st[next]!.id;
			return;
		}
		const n = section === "brief" ? briefLinesOf(d).length : notesOf(d, section).length;
		if (!n) return;
		if (section === "brief") { briefCursor = Math.min(n - 1, Math.max(0, briefCursor + delta)); return; }
		noteCursor = Math.min(n - 1, Math.max(0, noteCursor + delta));
	};

	// #17 (your request: "add an option to scroll page wise when reading the brief instead of just line by
	// line"). PageUp/PageDown are the keys everyone reaches for and press measured that they never arrive
	// here — pi handles them for the chat viewport. So the pager keys are letters/punctuation that DO
	// arrive, and the page size is the number of rows this overlay actually painted last frame (pageSize,
	// written by render) — a page here is a screenful of THIS plan, not a made-up 20.
	let pageSize = 10;

	const page = (dir: number): void => {
		const d = doc();
		if (!d) return;
		const step = Math.max(1, pageSize) * (dir < 0 ? -1 : 1);
		if (section === "steps") {
			const st = stepsOf(d);
			if (!st.length) return;
			const at = st.findIndex((s) => s.id === stepCursor);
			const next = Math.min(st.length - 1, Math.max(0, (at < 0 ? 0 : at) + step));
			stepCursor = st[next]!.id;
			return;
		}
		if (section === "brief") {
			const n = briefLinesOf(d).length;
			if (!n) return;
			briefCursor = Math.min(n - 1, Math.max(0, briefCursor + step));
			return;
		}
		const list = notesOf(d, section);
		if (!list.length) return;
		noteCursor = Math.min(list.length - 1, Math.max(0, noteCursor + step));
	};

	const jump = (to: "top" | "end"): void => {
		// #12/#15: the viewer's OWN jump keys. PageUp/PageDown/Home/End look like the obvious choice and
		// press measured that they never arrive — pi handles them for the chat viewport (PageUp even
		// triggers a full-screen repaint), so the overlay never sees them and a 90-line brief could only
		// be walked one line at a time. Letters arrive — that is what `x`, `e`, `a`, `D` prove — so the
		// jump is spelled with letters, vim-style: g = first row of this section, G = last.
		const d = doc();
		if (!d) return;
		if (section === "steps") {
			const st = stepsOf(d);
			if (!st.length) return;
			stepCursor = (to === "top" ? st[0] : st[st.length - 1])!.id;
			return;
		}
		if (section === "brief") {
			const n = briefLinesOf(d).length;
			if (!n) return;
			briefCursor = to === "top" ? 0 : n - 1;
			return;
		}
		const list = notesOf(d, section);
		if (!list.length) return;
		noteCursor = to === "top" ? 0 : list.length - 1;
	};

	const startEdit = (): void => {
		if (readOnly) { readOnlyKey(); return; }
		const d = doc();
		if (!d) return;
		const t = targetList(d);
		if (!t) { host.notify?.("Nothing to edit yet — press a to add a step."); return; }
		editing = t;
		const current = t.kind === "step"
			? stepsOf(d).find((s) => s.id === t.id)?.text ?? ""
			: t.kind === "briefLine"
				? briefLinesOf(d)[t.index] ?? ""
				: notesOf(d, section)[t.index] ?? "";
		openEditor(current, t.kind === "briefLine" ? "edit this line of the brief · ⏎ commits · esc cancels" : "type to append · backspace clears the row · ⏎ commits · esc cancels");
	};

	/** a / n: an empty editor for a NEW row (a step after the cursor, or a note in this section). */
	const startAdd = (): void => {
		if (readOnly) { readOnlyKey(); return; }
		if (section === "brief") {
			editing = { kind: "briefLine", index: -1 }; // -1 = a NEW line, appended after the cursor
			openEditor("", "new line of markdown (⏎ adds it after the cursor)");
			return;
		}
		// Backlog #15 (found by press scenario `t`): this used to be `{ kind: "step", id: hoveredStep() }`,
		// so ⏎ took the `update` branch and OVERWROTE the row the cursor sat on — while the editor it opened
		// said "new step (⏎ adds it after the cursor)". A key that denies its own hint row is the exact
		// failure a press test exists to catch: -1 means NEW here exactly like it does for notes.
		editing = section === "steps" ? { kind: "step", id: -1 } : { kind: "note", index: -1 };
		openEditor("", section === "steps" ? "new step (⏎ adds it after the cursor)" : `new ${SECTION_LABEL[section].toLowerCase()} (⏎ adds it)`);
	};

	const commitEdit = (): void => {
		const text = (draft?.getValue() ?? "").trim();
		const t = editing;
		closeEditor();
		if (!t || !text) { lastLog = "edit cancelled (nothing typed)"; return; }
		if (section === "steps") {
			if (t.kind !== "step") return;
			if (t.id === -1) {
				// "after the cursor" has to mean the row you were standing on when you pressed `a`. The id is
				// re-checked against the CURRENT document: the agent can remove that row while you type, and an
				// `after` naming a step that no longer exists would fail the whole op and eat what you typed —
				// so a vanished anchor falls back to plain append, which is where a new row belongs anyway.
				const anchor = stepCursor !== null && stepsOf(doc()).some((s) => s.id === stepCursor) ? stepCursor : undefined;
				// nextId is the id the new step is about to take (plan-doc's add does `next.nextId++`), so the
				// cursor can land on the row it just made — the same promise the brief makes for a new line.
				const newId = doc()?.nextId;
				if (apply({ action: "add", text, ...(anchor !== undefined ? { after: anchor } : {}) }) && newId !== undefined) stepCursor = newId;
			}
			else apply({ action: "update", id: t.id, text });
			return;
		}
		// #23: the brief is ONE string, so a line edit is "rebuild the body with this line replaced".
		// That keeps the model a single op (`brief`) instead of eleven ways to poke at a document.
		if (section === "brief") {
			const d = doc();
			if (!d) return;
			const lines = briefLinesOf(d);
			if (t.kind === "briefLine" && t.index >= 0 && t.index < lines.length) lines[t.index] = text;
			else {
				const at = Math.min(briefCursor + 1, lines.length);
				lines.splice(at, 0, text);
				briefCursor = at; // the cursor follows what you just added, the way a new step does
			}
			apply({ action: "brief", text: lines.join("\n") });
			return;
		}
		if (t.kind !== "note") return;
		const kind = SECTION_NOTE_KIND[section]!;
		if (t.index === -1) apply({ action: "note", kind, text });
		else apply({ action: "editNote", kind, index: t.index, text });
	};

	const deleteTarget = (): void => {
		const d = doc();
		if (!d) return;
		if (section === "steps") {
			const s = hoveredStep(d);
			if (!s) return;
			// Two-step delete (see the header): D on a live step DROPS it, D again removes it.
			if (s.status === "dropped") apply({ action: "remove", id: s.id });
			else apply({ action: "status", id: s.id, status: "dropped" });
			return;
		}
		if (section === "brief") {
			if (!d?.brief) return; // nothing written yet: D says nothing rather than arming a line that does not exist
			const lines = briefLinesOf(d);
			const at = Math.min(Math.max(0, briefCursor), lines.length - 1);
			if (armedBrief !== at) {
				armedBrief = at;
				lastLog = `D again deletes line ${at + 1}/${lines.length} of the brief — any other key cancels it`;
				return;
			}
			armedBrief = null;
			lines.splice(at, 1);
			briefCursor = Math.max(0, at - 1);
			// An empty body is the op that CLEARS the brief. The op log the model gets is the generic brief log;
			// the row the human reads says which line went away, because "brief set (4 lines)" is not an answer
			// to "did I just delete the line I meant?".
			if (apply({ action: "brief", text: lines.join("\n") })) {
				lastLog = `deleted brief line ${at + 1} — ${lines.filter((l) => l.trim()).length} line(s) left`;
			}
			return;
		}
		const list = notesOf(d, section);
		if (list.length === 0) return;
		const kind = SECTION_NOTE_KIND[section]!;
		apply({ action: "unnote", kind, index: Math.min(Math.max(0, noteCursor), list.length - 1) });
		noteCursor = Math.max(0, noteCursor - 1);
	};

	/** A key that means nothing in this section, said out loud instead of going silent. */
	const notHere = (key: string, where: string): void => {
		lastLog = `✗ ${key} does not apply to the ${SECTION_LABEL[section].toLowerCase()} — ${where}`;
	};

	const reorder = (delta: number): void => {
		const d = doc();
		const s = hoveredStep(d);
		if (!s) return;
		const st = stepsOf(d);
		const at = st.findIndex((x) => x.id === s.id);
		if (delta < 0) {
			if (at <= 0) return;
			// Up = land before the step two places up (`after` names the step we land behind).
			const twoUp = at - 2;
			apply({ action: "reorder", id: s.id, after: twoUp < 0 ? null : st[twoUp]!.id });
			return;
		}
		if (at >= st.length - 1) return;
		apply({ action: "reorder", id: s.id, after: st[at + 1]!.id });
	};

	// ── #23: the markdown body, rendered through pi-tui's Markdown ──────────────────
	// The body is now rendered BLOCK BY BLOCK (#12: the cursor ruler has to know which rows a source
	// line became), so a one-entry cache would miss on every block of every keystroke. Small bounded
	// Map instead: a plan's blocks do not change between keystrokes, and the eviction keeps a 20 KB
	// document from holding a rendered copy of every block forever.
	const MD_CACHE_MAX = 64;
	const mdCache = new Map<string, readonly string[]>();
	const markdownLines = (text: string, width: number): readonly string[] => {
		if (!text.trim()) return [];
		const key = `${width}\u0000${text}`;
		const hit = mdCache.get(key);
		if (hit) return hit;
		const lines = new Markdown(text, 0, 0, planMarkdownTheme(theme)).render(width);
		if (mdCache.size >= MD_CACHE_MAX) {
			const first = mdCache.keys().next();
			if (!first.done) mdCache.delete(first.value);
		}
		mdCache.set(key, lines);
		return lines;
	};

	const component: PlanEditorComponent & Component & Focusable = {
		// Focusable: pi sets this when the component gains/loses focus, and the embedded Input must
		// be told or IME candidate windows open at the wrong place (pi-tui docs, "Handle keyboard
		// input and focus").
		get focused() { return focused; },
		set focused(value: boolean) { focused = value; if (draft) draft.focused = value; },

		handleInput(data: string): void {
			if (matchesKey(data, "escape")) {
				// Esc while editing cancels THAT edit; Esc at the list closes the overlay (the edits
				// already committed — they are the plan now, which is why closing still reports them).
				if (editing) { closeEditor(); lastLog = "edit cancelled"; return; }
				done({ edits: applied.length, summary: applied });
				return;
			}
			if (draft) {
				if (matchesKey(data, "enter") || data === "\n") { commitEdit(); return; }
				draft.handleInput(data);
				return;
			}
			if (matchesKey(data, "ctrl+c")) { done({ edits: applied.length, summary: applied }); return; }
			// An armed Brief delete is a statement about ONE line under the cursor. Any key that is not D —
			// including the keystroke that opened an editor or moved the cursor or simply missed — cancels it,
			// so an arm can never survive the thing that made it untrue.
			if (data !== "D") armedBrief = null;
			if (matchesKey(data, "up") || data === "k") { move(-1); return; }
			if (matchesKey(data, "down") || data === "j") { move(1); return; }
			if (matchesKey(data, "pageUp")) { move(-5); return; }
			if (matchesKey(data, "pageDown")) { move(5); return; }
			// g / G: the jump keys that actually reach this overlay (see `jump`).
			if (data === "g") { jump("top"); return; }
			if (data === "G") { jump("end"); return; }
			// < / > and b / f: one page (one screenful of this plan) back or forward. They stay because they
			// are the shape every pager uses, but b/f are the primaries: on a German ANSI/QWERTZ keyboard the
			// `<>|` key sits next to Left Shift and `>` needs Shift on top of that, so a pager bound to them is
			// a pager you fight with. `b` and `f` (back / forward, standing in for the Ctrl+B / Ctrl+F every
			// pager uses — keys pi swallows here) are plain unshifted letters, the same glyph on every layout.
			if (data === "<" || data === "b") { page(-1); return; }
			if (data === ">" || data === "f") { page(1); return; }
			if (data === "\t") {
				section = SECTION_ORDER[(SECTION_ORDER.indexOf(section) + 1) % SECTION_ORDER.length]!;
				noteCursor = 0;
				return;
			}
			if (data === "e" || matchesKey(data, "enter") || data === "\n") { startEdit(); return; }
			if (data === "a" || data === "n") { startAdd(); return; }
			if (data === "x" || data === " ") {
				if (section === "brief") { notHere("x", "x cycles a STEP's status"); return; }
				const s = hoveredStep(doc());
				if (s) apply({ action: "cycle", id: s.id });
				return;
			}
			if (data === "w") {
				if (section === "brief") { lastLog = "✗ w does not apply to the brief — it wraps already; w is for STEPS"; return; }
				wrapRows = !wrapRows;
				lastLog = wrapRows ? "expanded — long steps wrap over several rows" : "compact — long steps are truncated to one row";
				return;
			}
			// #22: in a viewer the editing keys say why they do nothing instead of pretending to work.
			if (readOnly && (data === "e" || data === "a" || data === "n" || data === "x" || data === " " || data === "D" || data === "[" || data === "]" || data === "\n")) {
				readOnlyKey();
				return;
			}
			if (readOnly && matchesKey(data, "enter")) { readOnlyKey(); return; }
			if (data === "D") { deleteTarget(); return; }
			if (data === "[") { if (section === "brief") { notHere("[", "[ ] reorders STEPS"); return; } reorder(-1); return; }
			if (data === "]") { if (section === "brief") { notHere("]", "[ ] reorders STEPS"); return; } reorder(1); return; }
			// A typing mistake must not look like a dead key: every other keypress says what to press
			// instead, because nothing here is destructive enough to be worth a silent no-op. #17: "every
			// other key" means punctuation too — `<` used to fall through silently, which is indistinguishable
			// from the terminal swallowing the key (that is exactly the PageUp/PageDown case, so a key that
			// says nothing here is a key you cannot tell apart from a key that never arrived).
			if (data.length === 1 && data >= "!" && data <= "~") {
				if (readOnly) {
					lastLog = "read-only — ↑↓ move · Tab section · w wrap/compact · esc close";
					return;
				}
				lastLog = section === "brief"
					? `✗ ${data} does nothing here — ↑↓ line · g top · G end · b f page · ⏎ edit that line · a new line · D twice deletes it · Tab section · esc close`
					: `✗ ${data} does nothing here — ↑↓ move · g top G end · b f page · Tab section · e/⏎ edit · a add · x status · [ ] reorder · D drop/remove · w ${wrapRows ? "compact" : "expand"} · esc close`;
			}
		},

		render(width: number): string[] {
			const d = doc();
			const p = d ? planProgress(d) : EMPTY_PROGRESS;
			const termRows = (typeof process !== "undefined" && process.stdout?.rows) || 24;
			const w = Math.max(12, width);
			const out: string[] = [];

			const head = readOnly
				? `🗂 PREVIOUS PLAN (retired) — ${d?.title || "(untitled)"} · ${p.done + p.dropped}/${p.total} settled · rev ${d?.revised ?? 0}`
				: `📋 console plan — ${d?.title || "(untitled)"} · ${p.done}/${p.total} done${p.doing ? ` · ◐ ${p.doing} doing` : ""}${p.dropped ? ` · ✗ ${p.dropped} dropped` : ""} · rev ${d?.revised ?? 0}`;
			out.push(theme.fg("accent", head));
			if (d?.task) out.push(theme.fg("muted", `task: ${d.task}`));
			const bar = (labels: Record<PlanSection, string>) => SECTION_ORDER.map((s) => {
				const n = s === "steps" ? p.total : s === "brief" ? (d?.brief ? briefLinesOf(d).length : 0) : notesOf(d, s).length;
				return s === section ? theme.fg("accent", `[${labels[s]} ${n}]`) : theme.fg("dim", `[${labels[s]} ${n}]`);
			}).join("  ");
			// #23: five sections is one more bar than the terminal used to have to hold. Abbreviate BEFORE
			// truncating — a cut bar loses a section's COUNT, which is the one number that says whether there
			// are open questions to answer at all.
			const fullBar = bar(SECTION_LABEL);
			out.push(visibleWidth(fullBar) > w ? bar(SECTION_SHORT) : fullBar);
			// Two rows on purpose: one row of key hints is ~100 columns, and the terminal cuts it at 70 —
			// which is exactly where the `w` wrap state lived. #17's toggle has to be READABLE to exist.
			if (section === "brief") {
				out.push(theme.fg("dim", readOnly
					? "read-only viewer · ↑↓ line · g top · G end · Tab section · esc close"
					: "↑↓ line · g top · G end · b f page · Tab section"));
				out.push(theme.fg("dim", readOnly
					? "⏎ edits nothing here · b f page · /plan export last saves it"
					: "⏎ or e edits the line · a adds · D twice deletes · rendered markdown"));
			} else if (readOnly) {
				out.push(theme.fg("dim", "read-only viewer · ↑↓ move · g top · G end · Tab section · esc close"));
				out.push(theme.fg("dim", "w wrap · b f page · /plan export last [file] saves this plan"));
			} else {
				out.push(theme.fg("dim", "↑↓ move · Tab section · e/⏎ edit · a add · x status · D drop/remove"));
				out.push(theme.fg("dim", `[ ] reorder · g top G end · b f page · w ${wrapRows ? "compact" : "expand"} lines · esc close`));
			}

			// Build the body rows first (each row knows whether the cursor is on it), then fit a
			// cursor-anchored window into the terminal: the backlog #5 lesson — a long list must not
			// push the key hints or the action rows off screen.
			const rows: string[] = [];
			let hoveredRow = -1;
			// The editing box. Rendered on its own line under the row it belongs to (column arithmetic
			// against Input's internal prompt/caret is how these boxes end up one column off).
			const boxPrefix = "  › ";
			const boxLine = draft
				? theme.fg("accent", boxPrefix) + truncateToWidth(draft.render(Math.max(8, w - visibleWidth(boxPrefix)))[0] ?? "", Math.max(8, w - visibleWidth(boxPrefix)))
				: null;
			let boxPlaced = false;
			if (section === "brief") {
				// #23: the document half of a console plan, rendered by PI'S OWN markdown component — the same
				// renderer that draws the assistant's messages, so a table in a plan looks like a table in the
				// chat (box-drawing borders, width-aware cell wrapping included) rather than a pipe-separated
				// rumour of one.
				const src = briefLinesOf(d);
				const t = targetList(d);
				// Which SOURCE line ⏎ will edit, named out loud. The rendered body has no row-per-line mapping
				// (one source line becomes a heading, a blank, and four table rows), so this row is the only
				// honest way to say what a line edit is about — and it sits OUTSIDE the scrolled window, because
				// a cursor you cannot see while the body scrolls is not a cursor.
				if (t && t.kind === "briefLine" && d?.brief) {
					const preview = (src[t.index] ?? "").trim() || "(blank line)";
					// The arm is shown ON the row it points at, in the warning colour, in the same place the cursor
					// row normally lives — an armed delete you cannot see is just a key that deletes on the second press.
					out.push(armedBrief === t.index
						? theme.fg("warning", `❯ line ${t.index + 1}/${src.length} · D again DELETES it: ${truncateToWidth(preview, Math.max(8, w - 56))}`)
						: theme.fg("dim", `❯ line ${t.index + 1}/${src.length} · ⏎ edits: ${truncateToWidth(preview, Math.max(8, w - 34))}`));
					if (boxLine && draft && editing?.kind === "briefLine") { out.push(boxLine); boxPlaced = true; }
				}
				const blocks = briefBlocksOf(src);
				const cursorAt = t && t.kind === "briefLine" ? t.index : -1;
				// "(no brief yet)" is the ABSENT body, not a body of one blank line: "" is what `plan_doc
				// action=brief` with empty text (or /plan brief clear) leaves behind, and "\n" is a document
				// that has one blank line in it — a real line the cursor can sit on.
				if (!d?.brief) {
					rows.push(theme.fg("dim", "  (no brief yet — plan_doc action=brief writes one; /plan brief <file> loads markdown)"));
					hoveredRow = 0;
				} else {
					// #12, your report: "I need some sort of cursor when looking at the brief, otherwise it is
					// very cumbersome to edit it." The readout row above the body named the line but the body
					// itself carried no cursor at all, and the window anchored on a PROPORTIONAL guess (line 8 of
					// 12 ≈ row 8/12 down) — so moving the cursor could scroll a document you could not tell the
					// place in. Now every rendered row carries a ruler `❯ 12│` whose NUMBER IS THE SOURCE LINE,
					// and the window starts at the block the cursor is inside: exact, because the document is cut
					// into blocks that each render on their own (see briefBlocksOf).
					const digits = Math.max(2, String(src.length).length);
					const gut = 2 + digits;                 // "❯ 12│" = mark + space + number + │
					const bodyWidth = Math.max(10, w - gut - 1);
					const pad = (n: number) => String(n).padStart(digits);
					const blankRuler = theme.fg("dim", `  ${" ".repeat(digits)}│`);
					for (const b of blocks) {
						const inBlock = cursorAt >= b.start && cursorAt <= b.end;
						const text = src.slice(b.start, b.end + 1).join("\n");
						const rendered = markdownLines(text, bodyWidth);
						if (rendered.length === 0) {
							// A blank line renders to nothing, but it is still a line the cursor can sit on, edit
							// or delete — so it gets a row of its own instead of vanishing from the count.
							rows.push(`${inBlock ? theme.fg("accent", `❯ ${pad(cursorAt + 1)}│`) : blankRuler}`.replace(/\s+$/, ""));
							if (inBlock) hoveredRow = rows.length - 1;
							if (boxLine && draft && editing?.kind === "briefLine" && inBlock) { rows.push(boxLine); boxPlaced = true; }
							continue;
						}
						rendered.forEach((line, ri) => {
							// The ruler marks the FIRST row of the block and numbers it with the line `⏎` edits.
							// A multi-row block (a table, a fence) cannot say which of its rows one source line
							// became — so the cursor sits at the top of the block it belongs to, which is the
							// honest version of "your line is in here".
							const first = ri === 0;
							const ruler = !first
								? blankRuler
								: inBlock
									? theme.fg("accent", `❯ ${pad(cursorAt + 1)}│`)
									: theme.fg("dim", `  ${pad(b.start + 1)}│`);
							rows.push(`${ruler} ${line.replace(/\s+$/, "")}`.replace(/\s+$/, ""));
							if (inBlock && first) hoveredRow = rows.length - 1;
						});
						if (boxLine && draft && editing?.kind === "briefLine" && inBlock) { rows.push(boxLine); boxPlaced = true; }
					}
				}
			} else if (section === "steps") {
				const idWidth = Math.max(2, String(d?.steps.reduce((m, s) => Math.max(m, s.id), 0) ?? 0).length);
				for (const s of stepsOf(d)) {
					const hovered = hoveredStep(d)?.id === s.id;
					const mark = hovered ? "❯" : " ";
					const idCell = `#${String(s.id).padEnd(idWidth)}`;
					const prefix = `${mark} ${idCell} ${STATUS_GLYPH[s.status]} `;
					const indent = " ".repeat(visibleWidth(prefix));
					const glyph = theme.fg(STATUS_COLOR[s.status], STATUS_GLYPH[s.status]);
					const textBudget = Math.max(8, w - visibleWidth(prefix));
					// #17: only the step TEXT wraps, never the prefix — the continuation rows are indented by
					// exactly the prefix width, so they line up under the text they belong to.
					const pieces = wrapRows ? wrapTextWithAnsi(s.text, textBudget) : [truncateToWidth(s.text, textBudget)];
					const colorOf = (t: string): string =>
						s.status === "done" || s.status === "dropped"
							? theme.fg("dim", t)
							: s.status === "doing" ? theme.fg("warning", t) : theme.fg("text", t);
					if (hovered) hoveredRow = rows.length;
					pieces.forEach((piece, pi) => {
						const colored = colorOf(truncateToWidth(piece, textBudget));
						rows.push(pi === 0 ? `${mark} ${theme.fg("muted", idCell)} ${glyph} ${colored}` : indent + colored);
					});
					if (s.note) rows.push(indent + theme.fg("dim", truncateToWidth(s.note, Math.max(8, w - visibleWidth(prefix)))));
					if (boxLine && draft && editing?.kind === "step" && editing.id === s.id) {
						rows.push(boxLine);
						boxPlaced = true;
					}
				}
			} else {
				notesOf(d, section).forEach((n, i) => {
					const hovered = i === noteCursor;
					const prefix = `${hovered ? "❯" : " "} ${i + 1}. `;
					const indent = " ".repeat(visibleWidth(prefix));
					if (hovered) hoveredRow = rows.length;
					wrapTextWithAnsi(n, Math.max(10, w - visibleWidth(prefix))).forEach((line, li) => {
						rows.push((li === 0 ? prefix : indent) + theme.fg("muted", line));
					});
					if (boxLine && draft && editing?.kind === "note" && editing.index === i) {
						rows.push(boxLine);
						boxPlaced = true;
					}
				});
			}

			// A NEW row (id/index -1) has no existing row to hang the box on — pressing `a` on an
			// empty plan must still show the input, or the keypress looks broken.
			if (boxLine && !boxPlaced) rows.push(boxLine);

			const fixed = out.length + 2; // separator + last-action line
			let budget = Math.max(1, termRows - fixed);
			// A scrolled list also spends a row (or two) on the ↑/↓ indicators, so reserve them BEFORE
			// picking the window — otherwise a 60-step plan overshoots the terminal by exactly the row the
			// "more below" line needs (pi's renderer throws on a frame taller than the terminal).
			if (rows.length > budget) {
				const at = hoveredRow < 0 ? 0 : hoveredRow;
				const both = at > 0 && rows.length - 1 - at > 0;
				budget = Math.max(1, termRows - fixed - (both ? 2 : 1));
			}
			if (rows.length === 0) {
				out.push(theme.fg("dim", readOnly
					? "  (nothing in this section)"
					: section === "steps" ? "  (no steps yet — press a)" : `  (no ${SECTION_LABEL[section].toLowerCase()} yet — press n)`));
			} else {
				const anchor = hoveredRow < 0 ? 0 : hoveredRow;
				let start = anchor;
				let end = anchor;
				let used = 1;
				// The cursor row sits in the MIDDLE of what is painted: fill below and above alternately,
				// preferring below. Filling above first parked the cursor on the bottom row of the window, so
				// after a page jump you could see where you had come from and nothing of where you were going.
				for (;;) {
					let progressed = false;
					if (used + 1 <= budget && end + 1 < rows.length) { end++; used++; progressed = true; }
					if (used + 1 <= budget && start - 1 >= 0) { start--; used++; progressed = true; }
					if (!progressed) break;
				}
				// #17: the page a `<` / `>` jump moves by is this frame's visible row count — measured, not a
				// constant, so a jump lands where the next screenful begins on THIS terminal.
				pageSize = Math.max(1, used);
				for (let i = start; i <= end; i++) out.push(rows[i]!);
				if (start > 0) out.push(theme.fg("dim", `  ↑ ${start} more above`));
				if (rows.length - 1 - end > 0) out.push(theme.fg("dim", `  ↓ ${rows.length - 1 - end} more below`));
			}

			out.push(theme.fg("dim", "─".repeat(Math.max(4, Math.min(w, 60)))));
			out.push(lastLog ? theme.fg(lastLog.startsWith("✗") ? "warning" : "success", lastLog) : "");

			// pi's renderer throws on any line wider than the terminal, whatever its source (emoji
			// width quirks, a pasted 400-char step): measure every line last, ANSI-aware.
			return out.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
		},

		invalidate(): void {},
	};
	return component;
}

/**
 * Non-TUI rendering of the same document (print/rpc modes, and what a notify shows): plain lines,
 * no theme, no keys. Lives here so both hosts read one renderer.
 */
export function planPlainLines(doc: PlanDoc | null): string[] {
	if (!doc) return ["(no console plan)"];
	const p = planProgress(doc);
	return [
		`📋 console plan — ${doc.title || "(untitled)"} · ${p.done}/${p.total} done · rev ${doc.revised}`,
		...(doc.task ? [`task: ${doc.task}`] : []),
		...doc.steps.map((s) => `  ${STATUS_GLYPH[s.status]} #${s.id} ${s.text}${s.note ? ` (${s.note})` : ""}`),
		...(doc.decisions.length ? ["decisions:", ...doc.decisions.map((x) => `  - ${x}`)] : []),
		...(doc.constraints.length ? ["constraints:", ...doc.constraints.map((x) => `  - ${x}`)] : []),
		...(doc.openQuestions.length ? ["open questions:", ...doc.openQuestions.map((x) => `  - ${x}`)] : []),
		...(doc.brief ? ["brief:", ...doc.brief.split("\n").slice(0, 40).map((l) => `  ${l.replace(/\s+$/, "")}`), ...(doc.brief.split("\n").length > 40 ? [`  … ${doc.brief.split("\n").length - 40} more lines — /plan view reads the whole brief`] : [])] : []),
	];
}
