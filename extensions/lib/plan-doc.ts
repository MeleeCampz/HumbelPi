/**
 * plan-doc — the pure document model behind CONSOLE plan mode (backlog #16).
 *
 * Console plan mode is the TUI-native alternative to the file-backed plan mode: the plan is
 * not a markdown document the user has to open in an editor, it is a small structured object
 * that the TUI renders live (widget above the editor) and edits in place (the /plan view
 * overlay). The model reaches it through the `plan_doc` tool instead of through write/edit on
 * a pinned file.
 *
 *   PlanDoc
 *     title          one-line name of the plan
 *     task           the request being planned (verbatim-ish, so a resumed plan still says what
 *                    it was for)
 *     steps[]        { id, text, status: open | doing | done | dropped }
 *     decisions[]    choices made while planning (+ why) — the part a .md plan buries in prose
 *     constraints[]  hard limits the implementation must honor
 *     openQuestions[] questions the human still has to answer
 *     revised        mutation counter (widget signature, "revision 4" in the model text)
 *     nextId         step ids are STABLE and never reused (see below)
 *
 * WHY ADDRESS STEPS BY STABLE ID AND NOT BY POSITION: the model, the widget and the overlay
 * all refer to the same step at the same time, and a user edit (add / delete / reorder) can
 * change positions in the middle of a turn. `update 4` meaning "the fourth row right now"
 * would silently hit a different step. ids are printed as `#4` in every rendering, so there is
 * exactly one number in play and it never moves.
 *
 * WHY THIS FILE IS PURE (no pi, no pi-tui, no fs): same rule as plan-state.ts, ask-loop.ts and
 * plan-file.ts — tools/test-plan-doc.ts exercises every operation and every renderer, including
 * the terminal height budget, without the extension graph. `theme` enters as a structural
 * callback, never as an import.
 *
 * WHY `dropped` EXISTS AS A STATUS AND NOT AS A DELETE: "step 3 is out, we are not doing that"
 * is a planning decision worth keeping visible to both sides; hard deletes are a separate op
 * for when a row was simply wrong.
 */

export type PlanStepStatus = "open" | "doing" | "done" | "dropped";
export type PlanNoteKind = "decision" | "constraint" | "open";

/**
 * The two planning styles a console can be in (session-state, plan-state, guards).
 *   "file" the original: a pinned markdown document (<cwd>/.pi/PLAN.md)
 *   "tui"  console plan mode: this document, rendered live and edited in the TUI (#16)
 * Exported from THIS module (the document model) so every consumer names the same two values.
 */
export type PlanStyle = "file" | "tui";

export interface PlanStep {
	id: number;
	text: string;
	status: PlanStepStatus;
	/** Optional sub-note attached to this step (why it changed, a gotcha, a file to touch). */
	note?: string;
}

export interface PlanDoc {
	/** Discriminator: this document belongs to console plan mode, not to a plan file. */
	style: "tui";
	title: string;
	task: string;
	/**
	 * #23: the document half of a console plan — a markdown BODY the model writes and the human reads.
	 * Steps stay the steerable checklist; the brief is the "what and why" behind them: background, the
	 * approach, a comparison table, the API shape in a fenced block. It is ONE string of markdown, never
	 * parsed into structure: the model owns writing it, `plan-view.ts` owns rendering it (through pi's own
	 * Markdown component, so tables look like pi's tables), and export/import move it verbatim. Keeping it
	 * a string is what keeps the pure model pure — no markdown parser here, no structure to keep in sync.
	 */
	brief?: string;
	steps: PlanStep[];
	decisions: string[];
	constraints: string[];
	openQuestions: string[];
	revised: number;
	nextId: number;
	updatedAt: string;
}

/**
 * The brief lives in a session-state JSON file and in every tool result, so it needs a ceiling: a plan
 * is not a place to park a 200 KB document. Past the cap the model is told to write a shorter one rather
 * than having its text silently cut in half.
 */
export const MAX_BRIEF_CHARS = 20_000;

// ── Status vocabulary (shared by renderer, overlay and tool text) ──────────────

/** Cycle order for the overlay's `x` key and the tool's `cycle` op. */
export const STATUS_CYCLE: PlanStepStatus[] = ["open", "doing", "done", "dropped"];

export const STATUS_GLYPH: Record<PlanStepStatus, string> = {
	open: "○",
	doing: "◐",
	done: "✓",
	dropped: "✗",
};

/** pi theme color per status (same vocabulary as the backlog checklist: ✓ done, ◐ working, ○ open).
 *  Roles must be pi theme role names — 1.5.2 rejects unknown ones ("default" crashed the live panel; "text" is the body role). */
export const STATUS_COLOR: Record<PlanStepStatus, string> = {
	open: "text",
	doing: "warning",
	done: "success",
	dropped: "muted",
};

/** Structural stand-in for pi's theme so this module stays import-free. */
export interface PlanTheme {
	fg(color: string, text: string): string;
	strikethrough?(text: string): string;
}

export const PLAIN_THEME: PlanTheme = { fg: (_c, t) => t };

// ── Construction / normalization ──────────────────────────────────────────────

export function newPlanDoc(init: { title?: string; task?: string; steps?: string[]; brief?: string } = {}): PlanDoc {
	const doc: PlanDoc = {
		style: "tui",
		title: (init.title ?? "").trim(),
		task: (init.task ?? "").trim(),
		steps: [],
		decisions: [],
		constraints: [],
		openQuestions: [],
		revised: 0,
		nextId: 1,
		updatedAt: new Date().toISOString(),
	};
	const brief = (init.brief ?? "").replace(/\s+$/, "");
	if (brief) doc.brief = brief.slice(0, MAX_BRIEF_CHARS);
	for (const text of init.steps ?? []) {
		if (!text.trim()) continue;
		doc.steps.push({ id: doc.nextId++, text: text.trim(), status: "open" });
	}
	return doc;
}

/**
 * Defensive read: a PlanDoc comes off disk (session-state JSON) and from older builds, so
 * every field is defaulted and every step coerced. Anything unusable returns null rather than
 * a half-valid document — a corrupt plan must read as "no plan", not as an empty plan (those
 * mean different things to /plan approve and to the write guard).
 */
export function normalizePlanDoc(raw: unknown): PlanDoc | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Partial<PlanDoc>;
	if (r.style !== "tui") return null;
	const steps: PlanStep[] = [];
	let maxId = 0;
	for (const s of Array.isArray(r.steps) ? r.steps : []) {
		if (!s || typeof s !== "object") continue;
		const st = s as Partial<PlanStep>;
		const text = typeof st.text === "string" ? st.text.trim() : "";
		if (!text) continue;
		const status = STATUS_CYCLE.includes(st.status as PlanStepStatus) ? st.status as PlanStepStatus : "open";
		const id = typeof st.id === "number" && Number.isInteger(st.id) && st.id > 0 ? st.id : 0; // 0 = assigned below
		const step: PlanStep = { id, text, status };
		if (typeof st.note === "string" && st.note.trim()) step.note = st.note.trim();
		steps.push(step);
		if (id > maxId) maxId = id;
	}
	// Re-key the steps whose id is missing or duplicated, keeping display order.
	const seen = new Set<number>();
	for (const step of steps) {
		if (step.id === 0 || seen.has(step.id)) step.id = maxId + 1;
		maxId = Math.max(maxId, step.id);
		seen.add(step.id);
	}
	const listsOk = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
	const out: PlanDoc = {
		style: "tui",
		title: typeof r.title === "string" ? r.title.trim() : "",
		task: typeof r.task === "string" ? r.task.trim() : "",
		steps,
		decisions: listsOk(r.decisions),
		constraints: listsOk(r.constraints),
		openQuestions: listsOk(r.openQuestions),
		revised: typeof r.revised === "number" && Number.isFinite(r.revised) ? Math.max(0, Math.floor(r.revised)) : 0,
		nextId: maxId + 1,
		updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
	};
	// A brief is a string or nothing at all: a number/object/whatever on disk is dropped rather than
	// rendering "[object Object]" as the plan document. Truncated rather than rejected — a document that
	// was written is worth reading even if the file grew past the cap.
	if (typeof r.brief === "string" && r.brief.trim()) out.brief = r.brief.replace(/\s+$/, "").slice(0, MAX_BRIEF_CHARS);
	return out;
}

// ── Operations ────────────────────────────────────────────────────────────────

export type PlanOp =
	| { action: "set"; title?: string; task?: string }
	| { action: "add"; text: string; after?: number }
	| { action: "update"; id: number; text?: string; note?: string }
	| { action: "status"; id: number; status: PlanStepStatus }
	| { action: "cycle"; id: number }
	| { action: "reorder"; id: number; after?: number | null }
	| { action: "remove"; id: number }
	| { action: "note"; kind: PlanNoteKind; text: string }
	| { action: "unnote"; kind: PlanNoteKind; index: number }
	| { action: "editNote"; kind: PlanNoteKind; index: number; text: string }
	/** Replace the whole markdown body (empty text clears it). Whole-body, on purpose: the overlay edits a
	 *  LINE of it by rebuilding the string and sending it back, so the model has one op, not eleven. */
	| { action: "brief"; text: string }
	| { action: "reset" };

export interface PlanOpResult {
	ok: boolean;
	/** The new document (a copy) — the input is never mutated. Equal to `doc` when !ok. */
	doc: PlanDoc;
	/** One-line human/model-facing description of what changed ("step #3 → done"). */
	log: string;
	/** Present when ok === false: why the op did not apply. */
	reason?: string;
}

function copy(doc: PlanDoc): PlanDoc {
	return {
		...doc,
		steps: doc.steps.map((s) => ({ ...s })),
		decisions: [...doc.decisions],
		constraints: [...doc.constraints],
		openQuestions: [...doc.openQuestions],
	};
}

function done(doc: PlanDoc, log: string): PlanOpResult {
	const next = copy(doc);
	next.revised = doc.revised + 1;
	next.updatedAt = new Date().toISOString();
	return { ok: true, doc: next, log };
}

function fail(doc: PlanDoc, reason: string): PlanOpResult {
	return { ok: false, doc, log: reason, reason };
}

function findStep(doc: PlanDoc, id: number): PlanStep | undefined {
	return doc.steps.find((s) => s.id === id);
}

function stepLabel(s: PlanStep): string {
	return `#${s.id} ${s.text}`;
}

/** Apply one operation. Pure: `doc` is never mutated, `reset` returns a fresh empty document. */
export function applyPlanOp(doc: PlanDoc, op: PlanOp): PlanOpResult {
	switch (op.action) {
		case "set": {
			const title = op.title !== undefined ? op.title.trim() : doc.title;
			const task = op.task !== undefined ? op.task.trim() : doc.task;
			if (title === doc.title && task === doc.task) return fail(doc, "Nothing to set — title and task are already those values.");
			return done({ ...doc, title, task }, `plan header set: "${title || doc.title || "untitled"}"`);
		}

		case "add": {
			const text = op.text.trim();
			if (!text) return fail(doc, "add needs a non-empty step text.");
			const next = copy(doc);
			const step: PlanStep = { id: next.nextId++, text, status: "open" };
			if (op.after !== undefined) {
				const at = next.steps.findIndex((s) => s.id === op.after);
				if (at < 0) return fail(doc, `No step #${op.after} — cannot insert after it.`);
				next.steps.splice(at + 1, 0, step);
			} else {
				next.steps.push(step);
			}
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			return { ok: true, doc: next, log: `added step ${stepLabel(step)}` };
		}

		case "update": {
			const s = findStep(doc, op.id);
			if (!s) return fail(doc, `No step #${op.id}.`);
			const text = op.text?.trim();
			const note = op.note?.trim();
			if (!text && !note) return fail(doc, "update needs new text and/or a note.");
			const next = copy(doc);
			const target = next.steps.find((x) => x.id === op.id)!;
			if (text) target.text = text;
			if (note) target.note = note;
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			return { ok: true, doc: next, log: `edited step ${stepLabel(target)}` };
		}

		case "status": {
			const s = findStep(doc, op.id);
			if (!s) return fail(doc, `No step #${op.id}.`);
			if (!STATUS_CYCLE.includes(op.status)) return fail(doc, `Unknown status "${String(op.status)}" (open | doing | done | dropped).`);
			if (s.status === op.status) return fail(doc, `Step ${stepLabel(s)} is already ${op.status}.`);
			const next = copy(doc);
			next.steps.find((x) => x.id === op.id)!.status = op.status;
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			return { ok: true, doc: next, log: `step ${stepLabel(s)} → ${op.status}` };
		}

		case "cycle": {
			const s = findStep(doc, op.id);
			if (!s) return fail(doc, `No step #${op.id}.`);
			const nextStatus = STATUS_CYCLE[(STATUS_CYCLE.indexOf(s.status) + 1) % STATUS_CYCLE.length]!;
			return applyPlanOp(doc, { action: "status", id: op.id, status: nextStatus });
		}

		case "reorder": {
			const s = findStep(doc, op.id);
			if (!s) return fail(doc, `No step #${op.id}.`);
			const after = op.after === undefined ? null : op.after;
			if (after !== null) {
				if (after === op.id) return fail(doc, `Step #${op.id} is already where it is.`);
				if (!findStep(doc, after)) return fail(doc, `No step #${after} to move #${op.id} after.`);
			}
			const next = copy(doc);
			const from = next.steps.findIndex((x) => x.id === op.id);
			const [moved] = next.steps.splice(from, 1);
			if (after === null) next.steps.unshift(moved!);
			else next.steps.splice(next.steps.findIndex((x) => x.id === after) + 1, 0, moved!);
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			return { ok: true, doc: next, log: `moved step ${stepLabel(s)} to position ${next.steps.findIndex((x) => x.id === op.id) + 1}/${next.steps.length}` };
		}

		case "remove": {
			const s = findStep(doc, op.id);
			if (!s) return fail(doc, `No step #${op.id}.`);
			const next = copy(doc);
			next.steps = next.steps.filter((x) => x.id !== op.id);
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			return { ok: true, doc: next, log: `removed step ${stepLabel(s)}` };
		}

		case "note": {
			const text = op.text.trim();
			if (!text) return fail(doc, "note needs text.");
			const next = copy(doc);
			const list = op.kind === "decision" ? next.decisions : op.kind === "constraint" ? next.constraints : next.openQuestions;
			if (list.includes(text)) return fail(doc, `That ${op.kind} is already in the plan.`);
			list.push(text);
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			return { ok: true, doc: next, log: `added ${op.kind}: ${text}` };
		}

		case "unnote": {
			const next = copy(doc);
			const list = op.kind === "decision" ? next.decisions : op.kind === "constraint" ? next.constraints : next.openQuestions;
			if (op.index < 0 || op.index >= list.length) return fail(doc, `No ${op.kind} #${op.index + 1} (${list.length} exist).`);
			const [removed] = list.splice(op.index, 1);
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			return { ok: true, doc: next, log: `removed ${op.kind}: ${removed}` };
		}

		case "editNote": {
			// Replace a note IN PLACE rather than unnote+note: a note has no id, so a delete would
			// shift every later note while the overlay cursor is still pointing at the old position.
			const text = op.text.trim();
			if (!text) return fail(doc, "editNote needs text.");
			const list = op.kind === "decision" ? doc.decisions : op.kind === "constraint" ? doc.constraints : doc.openQuestions;
			if (op.index < 0 || op.index >= list.length) return fail(doc, `No ${op.kind} #${op.index + 1} (${list.length} exist).`);
			if (list[op.index] === text) return fail(doc, `That ${op.kind} is already that text.`);
			const next = copy(doc);
			const target = op.kind === "decision" ? next.decisions : op.kind === "constraint" ? next.constraints : next.openQuestions;
			target[op.index] = text;
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			return { ok: true, doc: next, log: `${op.kind} #${op.index + 1}: ${list[op.index]} → ${text}` };
		}

		case "brief": {
			// Verbatim markdown, minus trailing whitespace. Interior whitespace/newlines are the document —
			// a markdown table is nothing without its line breaks.
			const text = op.text.replace(/\s+$/, "");
			if (text.length > MAX_BRIEF_CHARS) {
				return fail(doc, `The brief would be ${text.length} characters — a plan body is capped at ${MAX_BRIEF_CHARS}. Write a shorter one (or put the long material in a file and reference it).`);
			}
			if (!text) {
				if (!doc.brief) return fail(doc, "There is no brief to clear.");
				const next = copy(doc);
				delete next.brief;
				next.revised = doc.revised + 1;
				next.updatedAt = new Date().toISOString();
				return { ok: true, doc: next, log: "brief cleared" };
			}
			if (doc.brief === text) return fail(doc, "The brief is already that text.");
			const next = copy(doc);
			next.brief = text;
			next.revised = doc.revised + 1;
			next.updatedAt = new Date().toISOString();
			const named = /^\s*#{1,6}\s+(.+)$/m.exec(text)?.[1]?.trim();
			return { ok: true, doc: next, log: `brief ${doc.brief ? "replaced" : "written"}: ${named ?? `${text.length} characters of markdown`}` };
		}

		case "reset": {
			const fresh = newPlanDoc({ title: doc.title, task: doc.task });
			fresh.revised = doc.revised + 1;
			return { ok: true, doc: fresh, log: "plan cleared (title and task kept)" };
		}
	}
}

// ── Progress ──────────────────────────────────────────────────────────────────

export interface PlanProgress {
	total: number;
	done: number;
	open: number;
	doing: number;
	dropped: number;
	/** Steps that still have work (open + doing) — the implementation instruction uses this. */
	remaining: PlanStep[];
	allDone: boolean;
}

export function planProgress(doc: PlanDoc): PlanProgress {
	const count = (s: PlanStepStatus) => doc.steps.filter((x) => x.status === s).length;
	const remaining = doc.steps.filter((s) => s.status === "open" || s.status === "doing");
	return {
		total: doc.steps.length,
		done: count("done"),
		open: count("open"),
		doing: count("doing"),
		dropped: count("dropped"),
		remaining,
		allDone: doc.steps.length > 0 && remaining.length === 0,
	};
}

/**
 * Cheap identity of a plan's rendered state — the widget refresh loop compares this instead of
 * re-rendering blindly, so "did anything change" is one string comparison per tick.
 */
export function planSignature(doc: PlanDoc | null): string {
	if (!doc) return "none";
	return `${doc.title}|${doc.task}|${doc.revised}|${doc.steps.map((s) => `${s.id}:${s.status}`).join(",")}|${doc.steps.length}|${doc.decisions.length}|${doc.constraints.length}|${doc.openQuestions.length}`;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const NOTES_HEADING: Record<PlanNoteKind, string> = {
	decision: "Decisions",
	constraint: "Constraints",
	open: "Open questions",
};

const notesOf = (doc: PlanDoc, kind: PlanNoteKind): string[] =>
	kind === "decision" ? doc.decisions : kind === "constraint" ? doc.constraints : doc.openQuestions;

/**
 * Model-facing text. Used three ways from one source so they cannot drift: the per-message
 * [PLAN MODE] frame, every plan_doc tool result, and the approval dialog body.
 */
export function renderPlanText(doc: PlanDoc, opts: { heading?: string; compact?: boolean; maxSteps?: number; maxBrief?: number } = {}): string {
	const p = planProgress(doc);
	const head = opts.heading ?? "PLAN";
	const shown = doc.steps.slice(0, opts.maxSteps ?? doc.steps.length);
	const hidden = doc.steps.length - shown.length;
	const lines: string[] = [
		`${head}: ${doc.title || "(untitled plan)"} — console plan, ${p.done}/${p.total} steps done, ${p.doing} in progress, ${p.dropped} dropped (revision ${doc.revised})`,
	];
	if (doc.task) lines.push(`Task: ${doc.task}`);
	lines.push("", "Steps:");
	if (doc.steps.length === 0) lines.push("  (no steps yet — add them with plan_doc action=add)");
	for (const s of shown) {
		lines.push(`  #${s.id} ${STATUS_GLYPH[s.status]} ${s.text}${s.note ? `  ⟵ ${s.note}` : ""}`);
	}
	if (hidden > 0) lines.push(`  … ${hidden} more step(s) — plan_doc action=show lists them all`);
	if (opts.compact) {
		// The per-message frame stays steps-only (a long plan must not be re-sent whole on every message),
		// but it NAMES the body: a model that does not know a brief exists will plan around it. The whole
		// text is one plan_doc action=show away.
		if (doc.brief) lines.push("", `Brief: ${doc.brief.split("\n").filter((l) => l.trim()).length} lines of markdown sit behind these steps — plan_doc action=show prints them, the user reads them rendered in /plan view (section Brief).`);
		return lines.join("\n");
	}
	for (const kind of ["decision", "constraint", "open"] as PlanNoteKind[]) {
		const list = notesOf(doc, kind);
		if (list.length === 0) continue;
		lines.push("", `${NOTES_HEADING[kind]}:`);
		for (const n of list) lines.push(`  - ${n}`);
	}
	// #23: the brief last, and verbatim. It is markdown, so it is NOT indented (four spaces would turn a
	// table or a fenced block into a code block for anything that reads this as markdown) and it is capped
	// so a tool result stays readable: the full text is one action=show away, and the human reads it whole
	// in /plan view.
	if (doc.brief) {
		const cap = opts.maxBrief ?? 4000;
		const shownBrief = doc.brief.length > cap ? `${doc.brief.slice(0, cap)}\n… ${doc.brief.length - cap} more characters (the whole body is in /plan view, section "Brief")` : doc.brief;
		lines.push("", "Brief (" + doc.brief.length + " characters of markdown — write it with plan_doc action=brief, read it rendered with /plan view):", "", shownBrief);
	}
	return lines.join("\n");
}

/**
 * #16: the row a panel should be showing RIGHT NOW.
 *
 *   implementing  the step in progress (◐), else the next one to do (○), else the last row
 *                 (a fully-done plan still has a "here is where you stopped" row)
 *   planning      the newest step — see planNewestIndex
 *
 * WHY THE ACTIVE ROW AND NOT THE TOP OF THE LIST: a 30-step plan in a 12-row panel used to
 * always render #1..#N, so when the agent was on step #22 the panel showed only finished rows and
 * the reader had to do the arithmetic. The window follows the work instead (#16).
 */
export function planActiveIndex(doc: PlanDoc): number {
	if (doc.steps.length === 0) return -1;
	const doing = doc.steps.findIndex((s) => s.status === "doing");
	if (doing >= 0) return doing;
	const open = doc.steps.findIndex((s) => s.status === "open");
	if (open >= 0) return open;
	return doc.steps.length - 1;
}

/** #16: the row a DRAFTING panel follows — the last one added, which is where the action is. */
export function planNewestIndex(doc: PlanDoc): number {
	return doc.steps.length - 1;
}

/**
 * Which row the window is anchored on when there is no overlay cursor to follow.
 *   "top"    the old behaviour (first row first) — the default, so nothing changes unasked
 *   "active" planActiveIndex — while a plan is being implemented
 *   "newest" planNewestIndex — while a plan is being drafted
 *   number   an explicit row index
 */
export type PlanAnchor = "top" | "active" | "newest" | number;

export interface PlanLineOptions {
	width: number;
	/** Hard cap on rendered rows (the widget/overlay height budget). */
	maxRows: number;
	/** Row index (into the step list) hovered by the overlay cursor, if any. */
	cursor?: number | null;
	/** #16: what to anchor the window on when `cursor` is absent (default "top"). */
	anchor?: PlanAnchor;
	/**
	 * #17: show long step texts in FULL by wrapping them over several rows instead of cutting them
	 * at the terminal width. Wrapped rows are counted against `maxRows` like any other row, so
	 * wrapping can never make the panel taller than the budget — it trades other steps for text.
	 */
	wrap?: boolean;
	/**
	 * The wrapping function, supplied by the host. pi-tui's `wrapTextWithAnsi` is what the real
	 * callers pass; this module must not import it (see the header), so the default here is a plain
	 * word wrap and the injected version is what decides the real terminal's behaviour.
	 */
	wrapText?: (text: string, width: number) => string[];
	/** Show the decisions/constraints/open-questions blocks. */
	notes?: boolean;
	/** Prefix for each step row (the overlay uses "❯ " for the hovered row). */
	cursorMark?: string;
	/** Trailing hint line (e.g. "/plan view" in the widget). */
	hint?: string;
	theme?: PlanTheme;
}

export interface PlanLines {
	lines: string[];
	hiddenAbove: number;
	hiddenBelow: number;
	/** #16: the row the window was anchored on (null when the plan has no steps). */
	activeIndex: number | null;
}

/**
 * Terminal-native rendering: a fixed row budget, a cursor-anchored window over the steps, and
 * "↑ N more above / ↓ N more below" indicators — the same shape that fixed the backlog checklist
 * running off-screen (backlog #5). EVERY line is truncated to `width`: pi's renderer throws when
 * a line is wider than the terminal, so an untruncated title is a crash, not a cosmetic issue.
 */
export function planWidgetLines(doc: PlanDoc, o: PlanLineOptions): PlanLines {
	const theme = o.theme ?? PLAIN_THEME;
	const width = Math.max(12, o.width);
	const cursor = o.cursor ?? null;
	const p = planProgress(doc);
	const idWidth = Math.max(2, String(doc.steps.reduce((m, s) => Math.max(m, s.id), 0)).length);

	// ── which row the window follows (cursor wins: a human pointing at a row outranks any rule) ──
	const anchorWanted = o.anchor ?? "top";
	const focusRaw = cursor !== null
		? cursor
		: anchorWanted === "active" ? planActiveIndex(doc)
			: anchorWanted === "newest" ? planNewestIndex(doc)
				: typeof anchorWanted === "number" ? anchorWanted
					: 0;
	const focus = doc.steps.length ? Math.min(Math.max(0, focusRaw), doc.steps.length - 1) : -1;
	const focusStep = focus >= 0 ? doc.steps[focus] : undefined;

	const statusTag = p.doing > 0 ? `${p.done}/${p.total} · ◐ ${p.doing}` : `${p.done}/${p.total}`;
	// #16: name the row the window is showing, so "↓ 15 more below" is not a mystery.
	const activeTag = focusStep && anchorWanted !== "top" && cursor === null ? ` · ▶ #${focusStep.id}` : "";
	const headText = `📋 console plan — ${doc.title || "(untitled)"} · ${statusTag}${activeTag} · rev ${doc.revised}`;
	const head = [theme.fg("accent", truncate(headText, width))];
	if (o.hint) head.push(theme.fg("dim", truncate(o.hint, width)));

	// Fixed rows: the header block + one separator + the two "more above/below" indicator slots.
	const fixed = head.length + 1 + 2;
	const budget = Math.max(1, o.maxRows - fixed);

	// ── row layout, computed once per step and shared by the windowing and the painting ──
	const layoutOf = (i: number) => {
		const s = doc.steps[i]!;
		const mark = cursor === i ? (o.cursorMark ?? "❯") : " ";
		const idCell = `#${String(s.id).padEnd(idWidth)}`;
		// The prefix is measured UNSTYLED and its real length is what the text budget subtracts.
		// Guessing a column count here is how a step line overflows the terminal by one column.
		const prefix = `${mark} ${idCell} ${STATUS_GLYPH[s.status]} `;
		const textBudget = Math.max(8, width - prefix.length);
		const pieces = o.wrap
			? (o.wrapText ?? defaultWrap)(s.text, textBudget)
			: [s.text];
		return { s, mark, idCell, prefix, textBudget, pieces };
	};
	/** How many budget rows this step costs — a wrapped step costs what it actually takes (#17). */
	const costOf = (i: number): number => Math.max(1, layoutOf(i).pieces.length);

	// ── the window: grow out from the focus row while the rows fit the budget ──
	let start = focus < 0 ? 0 : focus;
	let end = focus < 0 ? -1 : focus;
	if (focus >= 0) {
		let used = Math.min(costOf(focus), budget);
		for (let i = focus - 1; i >= 0; i--) {
			const c = costOf(i);
			if (used + c > budget) break;
			start = i; used += c;
		}
		for (let i = focus + 1; i < doc.steps.length; i++) {
			const c = costOf(i);
			if (used + c > budget) break;
			end = i; used += c;
		}
	}

	const lines: string[] = [...head];
	let stepRows = 0;
	for (let i = start; focus >= 0 && i <= end; i++) {
		const l = layoutOf(i);
		const room = budget - stepRows;
		if (room <= 0) break;
		const take = l.pieces.slice(0, room);
		// A step that got cut mid-wrap says so — a silently shortened row is how #17 came back.
		if (take.length < l.pieces.length) take[take.length - 1] = truncate(take[take.length - 1]!, l.textBudget);
		const glyph = theme.fg(STATUS_COLOR[l.s.status], STATUS_GLYPH[l.s.status]);
		const idCell = theme.fg("muted", l.idCell);
		const indent = " ".repeat(l.prefix.length);
		const colorOf = (t: string): string =>
			l.s.status === "done" || l.s.status === "dropped" ? theme.fg("dim", t)
				: l.s.status === "doing" ? theme.fg("warning", t)
					: theme.fg("text", t);
		take.forEach((piece, pi) => {
			const text = colorOf(truncate(piece, l.textBudget));
			lines.push(pi === 0 ? `${l.mark} ${idCell} ${glyph} ${text}` : `${indent}${text}`);
			stepRows += 1;
		});
	}
	const hiddenAbove = focus >= 0 ? start : 0;
	const hiddenBelow = focus >= 0 ? Math.max(0, doc.steps.length - 1 - end) : 0;
	if (hiddenAbove > 0) lines.push(theme.fg("dim", `  ↑ ${hiddenAbove} more above`));
	if (hiddenBelow > 0) lines.push(theme.fg("dim", `  ↓ ${hiddenBelow} more below`));
	lines.push(theme.fg("dim", "─".repeat(Math.max(4, Math.min(width, 48)))));

	if (o.notes) {
		// Notes share the SAME budget as the steps: an uncapped notes block is how a widget pushes
		// the editor off the terminal, which is the exact failure #5 was about.
		const indicatorRows = (hiddenAbove > 0 ? 1 : 0) + (hiddenBelow > 0 ? 1 : 0);
		let room = Math.max(0, o.maxRows - head.length - stepRows - indicatorRows - 1);
		let shownNotes = 0;
		let totalNotes = doc.decisions.length + doc.constraints.length + doc.openQuestions.length;
		outer: for (const kind of ["decision", "constraint", "open"] as PlanNoteKind[]) {
			const list = notesOf(doc, kind);
			if (list.length === 0) continue;
			if (room < 2) break; // a heading with no entry under it is noise
			lines.push(theme.fg("accent", `${NOTES_HEADING[kind]} (${list.length}):`));
			room -= 1;
			for (const n of list) {
				if (room < 1) break outer;
				lines.push(theme.fg("muted", `  ${truncate(n, Math.max(8, width - 4))}`));
				room -= 1; shownNotes += 1;
			}
		}
		if (shownNotes < totalNotes) lines.push(theme.fg("dim", `  … ${totalNotes - shownNotes} more note(s)`));
	}
	return { lines, hiddenAbove, hiddenBelow, activeIndex: focus >= 0 ? focus : null };
}

/**
 * Fallback word wrap for callers that do not inject one (tests, non-TUI prints). It only ever has
 * to be width-correct for plain strings — the real terminal path injects pi-tui's wrapTextWithAnsi,
 * which is the one that understands wide characters and colour codes.
 */
function defaultWrap(text: string, width: number): string[] {
	const w = Math.max(4, Math.floor(width));
	const out: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		let rest = word;
		while (rest.length > w) { // one word wider than the column: hard-split it
			if (line) { out.push(line); line = ""; }
			out.push(rest.slice(0, w));
			rest = rest.slice(w);
		}
		if (!line) { line = rest; continue; }
		if (line.length + 1 + rest.length <= w) { line += ` ${rest}`; continue; }
		out.push(line);
		line = rest;
	}
	if (line) out.push(line);
	return out.length ? out : [""];
}

/** Local width-safe truncation (this module must not import pi-tui; see the header). */
function truncate(text: string, width: number): string {
	// No ANSI in this module's own strings, so plain slicing is width-correct except for wide
	// characters, which the host re-measures with truncateToWidth when it paints the final line.
	const w = Math.max(1, Math.floor(width));
	if (text.length <= w) return text;
	return `${text.slice(0, Math.max(1, w - 1))}…`;
}

// ── Approval / implementation handoff ─────────────────────────────────────────

/**
 * The instruction handed to the model when a console plan is approved. Same contract as the
 * file mode's implementationInstruction (steps in order, honor decisions, report per step), but
 * built from the document — so "approved" and "what the model was told" are the same bytes the
 * user was looking at in the overlay.
 */
export function implementationInstructionFromDoc(doc: PlanDoc): string {
	const p = planProgress(doc);
	const steps = doc.steps.map((s) => `  #${s.id} [${s.status}] ${s.text}${s.note ? ` — ${s.note}` : ""}`).join("\n");
	const notes: string[] = [];
	for (const kind of ["decision", "constraint", "open"] as PlanNoteKind[]) {
		const list = notesOf(doc, kind);
		if (list.length) notes.push(`  ${NOTES_HEADING[kind]}: ${list.join(" · ")}`);
	}
	return [
		`PLAN APPROVED (console plan "${doc.title || "untitled"}", revision ${doc.revised}).`,
		"",
		"Steps:",
		steps || "  (none)",
		notes.length ? ["", "Honor these:", ...notes].join("\n") : "",
		// The brief travels with the approval because it holds the REASONING the plan was built on — the
		// comparison table, the API shape, the constraint you wrote down as a table. Capped so an approved
		// 40-step plan does not carry a 20 KB document into every turn; the full body stays one action=show away.
		doc.brief
			? ["", "The plan's brief (follow it — it is why these steps are these steps):", "", doc.brief.length > 3000 ? `${doc.brief.slice(0, 3000)}\n… ${doc.brief.length - 3000} more characters — plan_doc action=show prints the whole body.` : doc.brief].join("\n")
			: "",
		"",
		`Implement it now, in order. ${p.remaining.length} step(s) remain (${p.done} already done, ${p.dropped} deliberately dropped — do not re-open a dropped step unless the user asks). Mark each one as you go with plan_doc action=status id=… status=done, and report progress as you work: one short line per completed step (e.g. "✅ #2 done: …"). Deviate only when something is genuinely impossible, and say why first. Start with the first remaining step.`,
	].join("\n");
}

// ── Importing a markdown plan (bridges the two modes) ─────────────────────────

/**
 * Turn a .md plan into a console plan: numbered steps, `- [ ]` checkboxes and `##`/`###`
 * headings become steps; lines under a "decision"/"constraint"/"open question" heading become
 * notes. Deliberately forgiving — this is a convenience path (/plan import), not a parser.
 *
 * The metadata lines planDocToMarkdown itself writes (`Task: …`, `# Plan — …`) are skipped, so
 * export → import does not grow the plan by one step every round trip.
 */
export function planDocFromMarkdown(md: string, init: { title?: string; task?: string } = {}): PlanDoc {
	const doc = newPlanDoc(init);
	let bucket: PlanNoteKind | null = null;
	// A title the CALLER supplied (usually the file name, from /plan import) is a fallback, not a claim
	// about the document. Without that distinction a file that has its own `# Title` loses it to its own
	// file name, and the H1 line then fell through the heading chain into `constraints` — so importing
	// "imported-plan.md" titled "Rollout switch imported" produced a plan named after the file PLUS a
	// stray constraint row named after the document. A fallback title is exactly as good as the file name,
	// which is why an H1 is allowed to replace it.
	let titleIsFallback = !!doc.title;
	// #23: the three things a markdown document has that a checklist does not — a prose preamble, fenced
	// code, and tables — all become the BRIEF instead of being parsed into steps.
	//
	// WHY THAT IS THE RIGHT HOME FOR THEM: parseStepLine accepts "a bare line of prose" as a step, which is
	// how an import used to turn a paragraph of background into a to-do item, a ``` block into a step named
	// "```ts", and every row of a comparison table into its own step. A document block keeps them documents.
	const briefParts: string[] = [];
	let inBriefHeading = false;
	let fence: string[] | null = null;
	let seenPlanContent = false; // a step or a note has been parsed: the preamble is over
	const preamble: string[] = [];
	// A markdown table row: header, body, or the `|---|---|` delimiter — all start and end with a pipe.
	const isTableLine = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);

	for (const rawLine of md.split(/\r?\n/)) {
		const line = rawLine.trim();

		// Fenced code is document material whole: from the opening fence to the closing one it goes to the
		// brief untouched, and nothing inside it is read as a step.
		if (fence) {
			fence.push(rawLine);
			if (/^\s*```/.test(rawLine)) {
				briefParts.push(fence.join("\n").replace(/\s+$/, ""));
				fence = null;
			}
			continue;
		}
		if (/^\s*```/.test(rawLine)) { fence = [rawLine]; continue; }

		if (!line) {
			if (inBriefHeading) briefParts.push("");
			else if (!seenPlanContent) preamble.push("");
			continue;
		}
		if (/^[-─—]+$/.test(line)) continue;

		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			const level = h[1]!.length;
			const name = h[2]!.trim();
			const t = name.toLowerCase();
			// planDocToMarkdown's own title line, checked BEFORE the step-heading rule: "Plan — X" starts with
			// the word "plan", and the checklist-heading rule (which exists so `## Approach` still means the
			// checklist) was swallowing it — an exported plan came back from import with NO title at all.
			if (level === 1) {
				const own = name.replace(/^(console plan|the plan|plan)\s*[—–:-]\s*/i, "").trim();
				if (own && !seenPlanContent && (!doc.title || titleIsFallback)) { doc.title = own; titleIsFallback = false; continue; }
			}
			// A STEPS heading wins over a brief heading. "## Approach" has meant "the checklist starts here" in
			// this importer since file mode began, and a heading that silently turns a checklist into a document
			// block is a worse failure than a missing brief.
			if (/^(step|plan|approach|implement)/.test(t)) { inBriefHeading = false; bucket = null; continue; }
			if (/^(brief|background|context|summary|overview|why|scope|problem)/.test(t)) { inBriefHeading = true; continue; }
			inBriefHeading = false;
			if (/^(decision|choice|chosen)/.test(t)) bucket = "decision";
			else if (/^(constraint|risk|assumption|limitation)/.test(t)) bucket = "constraint";
			else if (/^(open question|question|unknown)/.test(t)) bucket = "open";
			else if (!doc.title) { doc.title = name; titleIsFallback = false; }
			// A top-level heading BEFORE any plan content is the document's own name, and it outranks a
			// caller's fallback. The `# Plan — …` heading planDocToMarkdown writes is stripped to what is
			// left after its marker, so an export→import round trip keeps the real title instead of gaining
			// "Plan — …" as a title or (the old behaviour) a constraint row.
			else if (level === 1 && titleIsFallback && !seenPlanContent) {
				const own = name.replace(/^(console plan|the plan|plan)\s*[—–:-]\s*/i, "").trim();
				if (own) { doc.title = own; titleIsFallback = false; }
			}
			// A heading that just restates the title is the document introducing itself twice, not a section.
			else if (name.toLowerCase() === (doc.title ?? "").toLowerCase()) { /* nothing to record */ }
			else if (bucket === null) doc.constraints.push(name); // a stray heading is a section boundary worth knowing
			continue;
		}
		if (inBriefHeading) { briefParts.push(rawLine); continue; }

		// Metadata the exporter writes; never a step, never the brief.
		const meta = line.match(/^(task|steps|plan)\b\s*(\([^)]*\))?\s*:?\s*(.*)$/i);
		if (meta && /^task$/i.test(meta[1]!) && bucket === null) {
			if (!doc.task && meta[3]) doc.task = meta[3].trim();
			continue;
		}
		if (meta && bucket === null && /^(steps|plan)$/i.test(meta[1]!)) continue;

		// A table (header, delimiter or body row) and the blank line before it belong together.
		if (isTableLine(line)) {
			briefParts.push(rawLine.replace(/\s+$/, ""));
			continue;
		}

		const parsed = parseStepLine(line);
		if (!parsed) continue;
		if (bucket) {
			seenPlanContent = true;
			notesOf(doc, bucket).push(parsed.text);
			continue;
		}
		seenPlanContent = true;
		doc.steps.push({ id: doc.nextId++, text: parsed.text, status: parsed.status });
	}
	// An unterminated fence is still document material, not a step.
	if (fence) briefParts.push(fence.join("\n"));
	const merged = [preamble.join("\n").trim(), ...briefParts]
		.map((p) => p.replace(/\s+$/, ""))
		.filter((p) => p.trim());
	if (merged.length) doc.brief = merged.join("\n\n").slice(0, MAX_BRIEF_CHARS);
	if (!doc.title && init.title) doc.title = init.title;
	return doc;
}

/** `- [x] text`, `1. text`, `* [ ] text`, or a bare line of prose → { text, status }. */
function parseStepLine(line: string): { text: string; status: PlanStepStatus } | null {
	const m = line.match(/^(?:(\d+)[.)]|[-*•])\s+(.*)$/) ?? [undefined, undefined, line];
	let rest = (m[2] ?? "").trim();
	if (!rest) return null;
	let status: PlanStepStatus = "open";
	const box = rest.match(/^\[([ xX~✓✗o○])\]\s*(.*)$/);
	if (box) {
		const c = box[1]!;
		status = c === "x" || c === "X" || c === "✓" ? "done" : c === "~" || c === "✗" ? "dropped" : "open";
		rest = (box[2] ?? "").trim();
	}
	if (!rest || /^[-─—]+$/.test(rest)) return null;
	return { text: rest, status };
}

/** Render a console plan back to markdown for /plan export. */
export function planDocToMarkdown(doc: PlanDoc): string {
	const p = planProgress(doc);
	const out: string[] = [`# Plan — ${doc.title || "(untitled)"}`, ""];
	if (doc.task) out.push(`Task: ${doc.task}`, "");
	// The brief is exported under a heading the importer recognises as a document block, so a plan exported
	// and imported again comes back with its tables and code fences intact instead of shredded into steps.
	if (doc.brief) out.push("## Brief", "", doc.brief, "");
	out.push(
		`## Steps (${p.done}/${p.total} done, revision ${doc.revised})`,
		"",
		...doc.steps.map((s, i) => `${i + 1}. ${s.status === "done" ? "[x]" : s.status === "dropped" ? "[~]" : "[ ]"} ${s.text}${s.note ? ` — ${s.note}` : ""}`),
	);
	for (const kind of ["decision", "constraint", "open"] as PlanNoteKind[]) {
		const list = notesOf(doc, kind);
		if (!list.length) continue;
		out.push("", `## ${NOTES_HEADING[kind]}`, "", ...list.map((n) => `- ${n}`));
	}
	return `${out.join("\n")}\n`;
}
