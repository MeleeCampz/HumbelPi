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

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
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

export type PlanSection = "steps" | "decisions" | "constraints" | "open";
export const SECTION_ORDER: PlanSection[] = ["steps", "decisions", "constraints", "open"];
export const SECTION_LABEL: Record<PlanSection, string> = {
	steps: "Steps",
	decisions: "Decisions",
	constraints: "Constraints",
	open: "Open questions",
};
const SECTION_NOTE_KIND: Record<Exclude<PlanSection, "steps">, PlanNoteKind> = {
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

interface Theme {
	fg(color: string, text: string): string;
}

/** What the cursor is on: a step (by stable id) or a note in the current section (by position). */
type Target = { kind: "step"; id: number } | { kind: "note"; index: number };

const EMPTY_PROGRESS: PlanProgress = { total: 0, done: 0, open: 0, doing: 0, dropped: 0, remaining: [], allDone: false };

/** What the overlay is, typed the way its callers use it: pi's Component has handleInput optional
 * (components may be display-only), but this one always handles keys — a host should not have to
 * write `?.` around every keystroke it forwards. */
export type PlanEditorComponent = Component & Focusable & { handleInput(data: string): void };

export function createPlanEditor(
	host: PlanEditorHost,
	theme: Theme,
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

	/** Clamp the cursor into the current list, healing a cursor whose step was removed underneath it. */
	const targetList = (d: PlanDoc | null): Target | null => {
		if (section === "steps") {
			const st = stepsOf(d);
			if (st.length === 0) { stepCursor = null; return null; }
			if (stepCursor === null || !st.some((s) => s.id === stepCursor)) stepCursor = st[0]!.id;
			return { kind: "step", id: stepCursor };
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
		const n = notesOf(d, section).length;
		if (!n) return;
		noteCursor = Math.min(n - 1, Math.max(0, noteCursor + delta));
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
			: notesOf(d, section)[t.index] ?? "";
		openEditor(current, "type to append · backspace clears the row · ⏎ commits · esc cancels");
	};

	/** a / n: an empty editor for a NEW row (a step after the cursor, or a note in this section). */
	const startAdd = (): void => {
		if (readOnly) { readOnlyKey(); return; }
		editing = section === "steps" ? { kind: "step", id: hoveredStep(doc())?.id ?? -1 } : { kind: "note", index: -1 };
		openEditor("", section === "steps" ? "new step (⏎ adds it after the cursor)" : `new ${SECTION_LABEL[section].toLowerCase()} (⏎ adds it)`);
	};

	const commitEdit = (): void => {
		const text = (draft?.getValue() ?? "").trim();
		const t = editing;
		closeEditor();
		if (!t || !text) { lastLog = "edit cancelled (nothing typed)"; return; }
		if (section === "steps") {
			if (t.kind !== "step") return;
			if (t.id === -1) apply({ action: "add", text });
			else apply({ action: "update", id: t.id, text });
			return;
		}
		if (t.kind !== "note") return;
		const kind = SECTION_NOTE_KIND[section as Exclude<PlanSection, "steps">]!;
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
		const list = notesOf(d, section);
		if (list.length === 0) return;
		const kind = SECTION_NOTE_KIND[section as Exclude<PlanSection, "steps">]!;
		apply({ action: "unnote", kind, index: Math.min(Math.max(0, noteCursor), list.length - 1) });
		noteCursor = Math.max(0, noteCursor - 1);
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
			if (matchesKey(data, "up") || data === "k") { move(-1); return; }
			if (matchesKey(data, "down") || data === "j") { move(1); return; }
			if (matchesKey(data, "pageUp")) { move(-5); return; }
			if (matchesKey(data, "pageDown")) { move(5); return; }
			if (data === "\t") {
				section = SECTION_ORDER[(SECTION_ORDER.indexOf(section) + 1) % SECTION_ORDER.length]!;
				noteCursor = 0;
				return;
			}
			if (data === "e" || matchesKey(data, "enter") || data === "\n") { startEdit(); return; }
			if (data === "a" || data === "n") { startAdd(); return; }
			if (data === "x" || data === " ") {
				const s = hoveredStep(doc());
				if (s) apply({ action: "cycle", id: s.id });
				return;
			}
			if (data === "w") { wrapRows = !wrapRows; lastLog = wrapRows ? "expanded — long steps wrap over several rows" : "compact — long steps are truncated to one row"; return; }
			// #22: in a viewer the editing keys say why they do nothing instead of pretending to work.
			if (readOnly && (data === "e" || data === "a" || data === "n" || data === "x" || data === " " || data === "D" || data === "[" || data === "]" || data === "\n")) {
				readOnlyKey();
				return;
			}
			if (readOnly && matchesKey(data, "enter")) { readOnlyKey(); return; }
			if (data === "D") { deleteTarget(); return; }
			if (data === "[") { reorder(-1); return; }
			if (data === "]") { reorder(1); return; }
			// A typing mistake must not look like a dead key: every other keypress says what to press
			// instead, because nothing here is destructive enough to be worth a silent no-op.
			if (/^[a-zA-Z0-9]$/.test(data)) {
				lastLog = readOnly
					? "read-only — ↑↓ move · Tab section · w wrap/compact · esc close"
					: `✗ ${data} does nothing here — ↑↓ move · Tab section · e/⏎ edit · a add · x status · [ ] reorder · D drop/remove · w ${wrapRows ? "compact" : "expand"} · esc close`;
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
			out.push(SECTION_ORDER.map((s) => {
				const n = s === "steps" ? p.total : notesOf(d, s).length;
				return s === section ? theme.fg("accent", `[${SECTION_LABEL[s]} ${n}]`) : theme.fg("dim", `[${SECTION_LABEL[s]} ${n}]`);
			}).join("  "));
			// Two rows on purpose: one row of key hints is ~100 columns, and the terminal cuts it at 70 —
			// which is exactly where the `w` wrap state lived. #17's toggle has to be READABLE to exist.
			if (readOnly) {
				out.push(theme.fg("dim", "read-only viewer · ↑↓ move · Tab section · w wrap/compact · esc close"));
				out.push(theme.fg("dim", "/plan export last [file] saves this plan as markdown"));
			} else {
				out.push(theme.fg("dim", "↑↓ move · Tab section · e/⏎ edit · a add · x status · D drop/remove"));
				out.push(theme.fg("dim", `[ ] reorder · w ${wrapRows ? "compact lines" : "expand lines"} · esc close`));
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
			if (section === "steps") {
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
				for (let i = anchor - 1; i >= 0 && used + 1 <= budget; i--) { used++; start = i; }
				for (let i = anchor + 1; i < rows.length && used + 1 <= budget; i++) { used++; end = i; }
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
	];
}
