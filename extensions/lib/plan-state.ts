/**
 * plan-state — the pure state machine behind planning mode (backlog #9, console mode #16).
 *
 * Three flags, one field pair: planning mode is ON, PAUSED, or OFF.
 *
 *   ON      planMode: true                      — only the pinned plan file may be written
 *   PAUSED  planMode: false, planPaused: true   — the plan is kept, the write guard is off
 *                                                (side work allowed), and the pinned file is
 *                                                still remembered so resume re-arms the same plan
 *   OFF     planMode: false, planPaused: false  — normal operation
 *
 * PAUSED is deliberately `planMode: false`: every existing gate in guards.ts/backlog.ts is
 * `if (ss.planMode)`, so a paused console behaves exactly like a normal one everywhere except
 * in the marker, `/plan status`, and what `/plan resume` restores. A `planMode: true` +
 * "except this one gate" design would have needed every call site re-audited — the failure mode
 * of that is a guard that silently applies (or silently doesn't).
 *
 *   action    from ON              from PAUSED             from OFF
 *   -------   ------------------   ---------------------   ----------------------
 *   on        no change            RESUME (same plan)      turn ON (bind plan)
 *   pause     PAUSE (keep plan)    no change               refused (nothing planned)
 *   resume    refused (planning)   RESUME (same plan)      refused (not paused)
 *   approve   OFF (+ EXECUTING in console mode), plan cleared/kept per style
 *   exit      OFF, plan KEPT       OFF, plan KEPT          no change
 *
 * `exit` and `approve` are the two ways out of a plan and they differ on purpose:
 * approve means "implement this", exit means "we are done planning, implement nothing".
 *
 * #16 adds the second planning style, and it is a PROPERTY OF THE PLAN, not a fourth flag:
 *
 *   planStyle "file"  the pinned markdown document (<cwd>/.pi/PLAN.md)
 *   planStyle "tui"   the console plan (a PlanDoc object, rendered live and edited in the TUI)
 *
 * Everything above stays true in both styles — pause/resume/exit/approve behave identically and
 * the same table decides both — which is why style is a field and not another mode. What differs
 * is only (a) which writes the guard blocks (file mode: everything except the pin; console mode:
 * every write), (b) the wording of the rules/frames, and (c) `planExecuting`: in console mode an
 * APPROVED plan stays in state so progress (○/◐/✓ per step) keeps tracking while the plan is
 * implemented. File mode has nothing to track — its plan is a document, not a checklist.
 *
 * Plain helper module: the only import is the console-plan document model (./plan-doc), which is
 * itself import-free, so tools/test-plan-state.ts and tools/test-plan-doc.ts can exercise the
 * whole table without the extension graph.
 */

import { planProgress, renderPlanText, type PlanDoc, type PlanStyle } from "./plan-doc";

export type PlanFlag = "on" | "paused" | "off";
export type PlanAction = "on" | "pause" | "resume" | "approve" | "exit";

/** The plan-relevant slice of a session state (SessionState satisfies this). */
export interface PlanView {
	planMode: boolean;
	/** backlog #9: planning mode PAUSED — plan kept, write guard off. Absent (old state files) = false. */
	planPaused?: boolean;
	planFile: string | null;
	/** #16: file mode (pinned .md) or console mode (PlanDoc). Absent (old state files) = "file". */
	planStyle?: PlanStyle;
	/** #16: the console plan, when planStyle === "tui". */
	planDoc?: PlanDoc | null;
	/**
	 * #16: an APPROVED console plan is being implemented. planMode is OFF (writes are allowed —
	 * that is the point), but the plan document stays in state so the step checklist and the
	 * progress widget keep tracking. Only ever set in console mode.
	 */
	planExecuting?: boolean;
}

export interface PlanTransition {
	/** false = the action does not apply in this state (e.g. pause with nothing planned). */
	ok: boolean;
	/** false = nothing changes (e.g. pausing an already-paused plan). */
	changed: boolean;
	/** Resulting flag — equal to the current flag when ok/changed is false. */
	flag: PlanFlag;
	/** Resulting pinned file. null only via approve (exit KEEPS the file on purpose). */
	file: string | null;
	/** #16: resulting "approved console plan is executing" state. */
	executing: boolean;
	/** Human-facing explanation, for notify() and for the model-facing messages. */
	reason: string;
}

export function planFlagOf(v: PlanView): PlanFlag {
	if (v.planMode) return "on";
	return v.planPaused ? "paused" : "off";
}

/** #16: the planning style of this console's plan. Anything unknown is the original file mode. */
export function planStyleOf(v: PlanView): PlanStyle {
	return v.planStyle === "tui" ? "tui" : "file";
}

/** #16: the console plan document, or null (file mode, or nothing planned yet). */
export function consolePlanOf(v: PlanView): PlanDoc | null {
	return planStyleOf(v) === "tui" ? v.planDoc ?? null : null;
}

/** #16: is an approved console plan currently being implemented? */
export function planExecutingOf(v: PlanView): boolean {
	return v.planExecuting === true && consolePlanOf(v) !== null;
}

/**
 * #16: which style a NEW plan in this console uses — shared by every entry point (/plan on, the
 * backlog "Plan these" row) so they cannot disagree about what a bare "/plan on" means.
 *
 * An existing plan's style always wins: a console that has a console plan gets console plans, and a
 * console with a pinned plan file keeps using it (a paused console resumes the plan it suspended,
 * which is the same rule in planTransition). Only a console with NO plan anywhere consults the
 * machine default (/plan default tui|file).
 */
export function planStyleForNewPlan(v: PlanView, machineDefault: PlanStyle | undefined): PlanStyle {
	if (v.planStyle === "tui" || (v.planDoc ?? null) !== null) return "tui";
	if (v.planFile) return "file";
	return machineDefault === "tui" ? "tui" : "file";
}

/**
 * Is the plan-file write guard armed? True only in ON. This is the ONE question the write guard
 * asks (guards.ts asks it through this helper rather than reading planMode directly), so the
 * claim "PAUSED behaves like a normal console" has a single testable point instead of fifteen
 * scattered `if (ss.planMode)` checks that would each have to be re-audited.
 */
export function planGuardArmed(v: PlanView): boolean {
	return planFlagOf(v) === "on";
}

function result(cur: PlanView, flag: PlanFlag, ok: boolean, changed: boolean, reason: string, file: string | null = cur.planFile, executing: boolean = false): PlanTransition {
	return { ok, changed, flag, file, executing, reason };
}

/**
 * The whole table. Pure: `cur` is never mutated, `file` for "on" is whatever the caller had
 * (callers bind a fresh defaultPlanFile / newPlanDoc when it is null — binding needs fs, this
 * does not).
 */
export function planTransition(cur: PlanView, action: PlanAction): PlanTransition {
	const from = planFlagOf(cur);
	switch (action) {
		case "on":
			if (from === "on") return result(cur, "on", true, false, "Already in planning mode.");
			// PAUSED + /plan on = RESUME, with the same plan behind it (file or console). A paused
			// console has no reason to start a second plan behind the one it suspended.
			if (from === "paused") return result(cur, "on", true, true, `Planning resumed (${planLabel(cur)} stays in play).`);
			return result(cur, "on", true, true, "Planning mode turned ON.");

		case "pause":
			if (from === "on") return result(cur, "paused", true, true, `Planning paused — ${planLabel(cur)} is kept; writes are allowed again. Resume with /plan resume.`);
			if (from === "paused") return result(cur, "paused", true, false, "Planning mode is already paused.");
			return result(cur, "off", false, false, "Nothing to pause — planning mode is OFF. Start it with /plan on [task] (or /plan tui [task]).");

		case "resume":
			if (from === "paused") return result(cur, "on", true, true, `Planning resumed — ${planLabel(cur)} is back under the write guard.`);
			if (from === "on") return result(cur, "on", true, false, "Already planning — nothing to resume.");
			return result(cur, "off", false, false, "Nothing is paused — planning mode is OFF. Start it with /plan on [task] (or /plan tui [task]).");

		case "approve": {
			if (from !== "on") return result(cur, from, false, false, "Not in planning mode — nothing to approve.");
			// Console mode keeps its document after approval so step progress keeps tracking during
			// implementation; file mode unbinds the pin, as it always has (the document stays on disk).
			const executing = planStyleOf(cur) === "tui";
			return result(cur, "off", true, true, executing
				? "Plan approved — planning mode OFF, the console plan stays live so step progress keeps tracking."
				: "Plan approved — planning mode OFF and the plan file unbound.", null, executing);
		}

		case "exit":
			if (from === "off") return result(cur, "off", true, false, "Planning mode is already OFF.");
			// The plan survives: it is a document the user asked for, and dropping it here would make
			// the next /plan on start from scratch in the same session.
			return result(cur, "off", true, true, from === "paused"
				? "Planning mode exited — the plan is kept, nothing is implemented."
				: `Planning mode exited — ${planLabel(cur)} is kept, nothing is implemented. /plan on to plan again.`);
	}
}

/** What the plan of this console IS, in one phrase — used by every message so both styles read consistently. */
export function planLabel(v: PlanView): string {
	if (planStyleOf(v) === "tui") {
		const d = consolePlanOf(v);
		if (!d) return "the console plan";
		const p = planProgress(d);
		return `the console plan "${d.title || "untitled"}" (${p.done}/${p.total} steps, revision ${d.revised})`;
	}
	return v.planFile ? `the plan file ${v.planFile}` : "the plan file";
}

/** Apply a transition to a state object in place (for updateSessionState's mutate callback). */
export function applyPlanTransition(s: PlanView, action: PlanAction): PlanTransition {
	const t = planTransition(s, action);
	if (t.changed) {
		s.planMode = t.flag === "on";
		s.planPaused = t.flag === "paused";
		s.planExecuting = t.executing;
		if (t.file === null) s.planFile = null;
	}
	return t;
}

// ── Presentation (window title, footer marker, status line) ────────────────

/** Window-title marker: combines with 🌙/🔥 in guards.ts applyTitle. */
export function planTitleMarker(v: PlanView): string | null {
	const name = planStyleOf(v) === "tui" ? "📋 CONSOLE PLAN" : "📋 PLAN";
	if (v.planMode) return name;
	if (v.planPaused) return `${name} ⏸`;
	// #16: an approved console plan being implemented still deserves a marker — the checklist is
	// live and the user should be able to tell at a glance.
	return planExecutingOf(v) ? `${name} ▶` : null;
}

/** Footer marker (single cell, same slot as 🛡️/🔥/🌙). */
export function planFooterMarker(v: PlanView): string | null {
	if (v.planMode) return "📋";
	if (v.planPaused) return "📋⏸";
	return planExecutingOf(v) ? "📋▶" : null;
}

/** One-line status, shared by /plan status and /guards status. */
export function planStatusLine(v: PlanView): string {
	const consoleMode = planStyleOf(v) === "tui";
	switch (planFlagOf(v)) {
		case "on":
			return consoleMode
				? `📋 ON (console plan mode, this console — ${planLabel(v)}). Edit it with /plan view; finish_plan or /plan approve to implement, /plan reject [reason] to revise, /plan pause to suspend the write guard, /plan exit to leave.`
				: `📋 ON (this console — ${v.planFile ?? "no file bound"}). finish_plan or /plan approve to implement, /plan reject [reason] to revise, /plan pause to suspend the write guard, /plan exit to leave.`;
		case "paused":
			return consoleMode
				? `⏸ PAUSED (this console — ${planLabel(v)} is kept, /plan view still opens it). Writes are allowed again; the paused plan itself is not approved. /plan resume to keep planning, /plan exit to leave.`
				: `⏸ PAUSED (this console — plan kept at ${v.planFile ?? "unbound"}). Writes are allowed again; the paused plan itself is not approved. /plan resume to keep planning, /plan exit to leave.`;
		case "off":
			if (planExecutingOf(v)) {
				const p = planProgress(consolePlanOf(v)!);
				return `▶ IMPLEMENTING (approved console plan — ${p.done}/${p.total} steps done, ${p.remaining.length} remaining). plan_doc can still mark steps; /plan tui reopens planning.`;
			}
			return "off. Start with: /plan on [task] (or /plan tui [task] to plan in the TUI)";
	}
}

/** Frame injected into every user message while planning is paused. */
export function planPausedFrame(v: PlanView): string {
	if (planStyleOf(v) === "tui") {
		return `[PLAN MODE PAUSED] Planning mode is PAUSED for this console: ${planLabel(v)} is kept but NOT approved. Normal work and normal writes are allowed again. Do not implement the paused plan and do not rebuild it unless asked. When the side task is done, ask the user to run /plan resume to continue planning.`;
	}
	const file = v.planFile ?? "(no plan file bound)";
	return `[PLAN MODE PAUSED] Planning mode is PAUSED for this console: the plan at ${file} is kept but NOT approved. Normal work and normal writes are allowed again (the plan file is no longer special). Do not implement the paused plan itself and do not rewrite ${file} unless asked. When the side task is done, ask the user to run /plan resume to continue planning.`;
}

/**
 * #16: the frame for a console plan that was approved and is being implemented. Injected on every
 * user message for the whole implementation, so "which checklist am I working through" cannot
 * drift out of context even after a compaction.
 */
export function planExecutingFrame(v: PlanView): string | null {
	const d = consolePlanOf(v);
	if (!planExecutingOf(v) || !d) return null;
	const p = planProgress(d);
	return `[PLAN IMPLEMENTING] The approved console plan "${d.title || "untitled"}" is being implemented: ${p.done}/${p.total} steps done, ${p.remaining.length} remaining. Mark each step as you finish it (plan_doc action=status id=… status=done). Plan text:\n\n${renderPlanText(d, { heading: "PLAN", compact: true, maxSteps: 40 })}`;
}

// ── Model-facing instructions (shared: guards.ts and backlog.ts used to carry two
//    near-identical copies of the rules text, which is how they drift) ──────────────

/** The rules block sent when planning mode turns ON. */
export function planningRulesText(file: string): string {
	return `Planning mode is ACTIVE. Rules: do not implement anything; the only file you may create or modify is ${file} — write the complete plan there, replacing any stale content. Reading, web search and read-only commands are allowed. When you hit a real decision or ambiguity (architecture choice, trade-off, scope question), use the ask_user tool with concrete options instead of deciding silently — I want to make those calls.`;
}

/** Same rules, worded for a PAUSED→ON resume: the plan is already there, do not restart it. */
export function planningResumeText(file: string): string {
	return `Planning mode is RESUMED (it was paused). Rules: do not implement anything; the only file you may create or modify is ${file} — keep revising the plan that is already there instead of starting a new one. Reading, web search and read-only commands are allowed. Use the ask_user tool for real decisions instead of deciding silently.`;
}

/**
 * #16: console plan mode rules. The plan is an object the user WATCHES, so the instruction is
 * "build the document with plan_doc", not "write a file": every step, decision and constraint is
 * a row the user can read and edit in the TUI while the plan is being drafted.
 */
export function consolePlanningRulesText(doc: PlanDoc | null, opts: { resumed?: boolean; task?: string } = {}): string {
	const head = opts.resumed
		? "Planning mode is RESUMED in CONSOLE plan mode (it was paused) — revise the plan that already exists instead of starting a new one."
		: "Planning mode is ACTIVE in CONSOLE plan mode: the plan is a live checklist inside the terminal, not a markdown file.";
	return [
		head,
		"",
		"Rules:",
		"- Do not implement anything and do not write ANY file — every write is blocked while planning is on (no plan file exists in this mode).",
		"- Build the plan with the plan_doc tool: action=add for each step, action=note kind=decision|constraint|open for the reasoning, action=set for the title/task, action=status when a step is settled. The user watches it appear live and edits it with /plan view.",
		"- Steps must be executable and ordered; decisions record what was chosen and why; constraints are the hard limits an implementation must honor.",
		"- Reading, web search and read-only commands stay free.",
		"- When you hit a real decision or ambiguity (architecture choice, trade-off, scope question), use the ask_user tool with concrete options instead of deciding silently — I want to make those calls.",
		opts.task ? `Your task: ${opts.task}` : "Wait for the task, then draft the plan.",
	].join("\n");
}

/** Appended to every planning kickoff so the approval dialog is actually reached. */
export function finishPlanReminder(): string {
	return "When the plan is complete, call the finish_plan tool with a short summary to present it for approval — don't just tell me it's done.";
}

/** Steer sent to a RUNNING turn when planning is paused, exited, or turned off mid-run. */
export function planningPausedSteer(file: string): string {
	return `Planning mode just got PAUSED for this console: the plan at ${file} is kept but unapproved, and the plan-file write guard is off — normal work and normal writes are allowed again. Do NOT implement the paused plan and do NOT rewrite ${file} unless the user asks. Do the side task, then tell the user to run /plan resume to continue planning.`;
}

/** #16: the same steer for a console plan (there is no file to name). */
export function consolePausedSteer(v: PlanView): string {
	return `Planning mode just got PAUSED for this console: ${planLabel(v)} is kept but unapproved and the write guard is off — normal work and normal writes are allowed again. Do NOT implement the paused plan, do NOT call plan_doc to rebuild it, and do NOT call finish_plan. Do the side task, then tell the user to run /plan resume to bring the plan back.`;
}

/** Steer sent to a RUNNING turn when planning mode is exited (no implementation follows). */
export function planningExitedSteer(file: string): string {
	return `Planning mode just got EXITED for this console: the plan at ${file} is kept as a document but it is NOT approved. Do NOT implement it and do not call finish_plan again. Wrap up, summarize the plan briefly, and wait for a new instruction.`;
}

/** #16: the same steer for a console plan. */
export function consoleExitedSteer(v: PlanView): string {
	return `Planning mode just got EXITED for this console: ${planLabel(v)} is kept as a document (still readable with /plan view) but it is NOT approved. Do NOT implement it and do not call finish_plan or plan_doc again. Summarize it briefly, end your turn, and wait for a new instruction.`;
}
