/**
 * plan-state — the pure state machine behind planning mode (backlog #9).
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
 *   on        no change            RESUME (same file)      turn ON (bind file)
 *   pause     PAUSE (keep file)    no change               refused (nothing planned)
 *   resume    refused (planning)   RESUME (same file)      refused (not paused)
 *   approve   OFF, file cleared    refused                 refused
 *   exit      OFF, file KEPT       OFF, file KEPT          no change
 *
 * `exit` and `approve` are the two ways out of a plan and they differ on purpose:
 * approve means "implement this", exit means "we are done planning, implement nothing".
 *
 * Plain helper module: no pi imports, registers nothing (same rule as ask-loop.ts and
 * plan-file.ts), so tools/test-plan-state.ts can exercise the whole table without the
 * extension graph.
 */

export type PlanFlag = "on" | "paused" | "off";
export type PlanAction = "on" | "pause" | "resume" | "approve" | "exit";

/** The plan-relevant slice of a session state (SessionState satisfies this). */
export interface PlanView {
	planMode: boolean;
	/** backlog #9: planning suspended — plan kept, write guard off. Absent (old state files) = false. */
	planPaused?: boolean;
	planFile: string | null;
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
	/** Human-facing explanation, for notify() and for the model-facing messages. */
	reason: string;
}

export function planFlagOf(v: PlanView): PlanFlag {
	if (v.planMode) return "on";
	return v.planPaused ? "paused" : "off";
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

function result(cur: PlanView, flag: PlanFlag, ok: boolean, changed: boolean, reason: string, file: string | null = cur.planFile): PlanTransition {
	return { ok, changed, flag, file, reason };
}

/**
 * The whole table. Pure: `cur` is never mutated, `file` for "on" is whatever the caller had
 * (callers bind a fresh defaultPlanFile when it is null — binding needs fs, this does not).
 */
export function planTransition(cur: PlanView, action: PlanAction): PlanTransition {
	const from = planFlagOf(cur);
	switch (action) {
		case "on":
			if (from === "on") return result(cur, "on", true, false, "Already in planning mode.");
			// PAUSED + /plan on = resume, with the same pinned file. A paused console has no
			// reason to start a second plan behind the one it suspended.
			if (from === "paused") return result(cur, "on", true, true, `Planning resumed (same plan file: ${cur.planFile ?? "unbound"}).`);
			return result(cur, "on", true, true, "Planning mode turned ON.");

		case "pause":
			if (from === "on") return result(cur, "paused", true, true, `Planning paused — plan kept at ${cur.planFile ?? "unbound"}; writes are allowed again. Resume with /plan resume.`);
			if (from === "paused") return result(cur, "paused", true, false, "Planning mode is already paused.");
			return result(cur, "off", false, false, "Nothing to pause — planning mode is OFF. Start it with /plan on [task].");

		case "resume":
			if (from === "paused") return result(cur, "on", true, true, `Planning resumed — only ${cur.planFile ?? "the plan file"} may be written again.`);
			if (from === "on") return result(cur, "on", true, false, "Already planning — nothing to resume.");
			return result(cur, "off", false, false, "Nothing is paused — planning mode is OFF. Start it with /plan on [task].");

		case "approve":
			if (from !== "on") return result(cur, from, false, false, "Not in planning mode — nothing to approve.");
			return result(cur, "off", true, true, "Plan approved — planning mode OFF and the plan file unbound.", null);

		case "exit":
			if (from === "off") return result(cur, "off", true, false, "Planning mode is already OFF.");
			// The plan file survives: it is a document the user asked for, and unbinding it here
			// would make the next /plan on start from a fresh file in the same session.
			return result(cur, "off", true, true, from === "paused"
				? "Planning mode exited — the plan file is kept, nothing is implemented."
				: "Planning mode exited — the plan file is kept, nothing is implemented. /plan on to plan again.");
	}
}

/** Apply a transition to a state object in place (for updateSessionState's mutate callback). */
export function applyPlanTransition(s: PlanView, action: PlanAction): PlanTransition {
	const t = planTransition(s, action);
	if (t.changed) {
		s.planMode = t.flag === "on";
		s.planPaused = t.flag === "paused";
		if (t.file === null) s.planFile = null;
	}
	return t;
}

// ── Presentation (window title, footer marker, status line) ────────────────

/** Window-title marker: combines with 🌙/🔥 in guards.ts applyTitle. */
export function planTitleMarker(v: PlanView): string | null {
	if (v.planMode) return "📋 PLAN";
	return v.planPaused ? "📋 PLAN ⏸" : null;
}

/** Footer marker (single cell, same slot as 🛡️/🔥/🌙). */
export function planFooterMarker(v: PlanView): string | null {
	if (v.planMode) return "📋";
	return v.planPaused ? "📋⏸" : null;
}

/** One-line status, shared by /plan status and /guards status. */
export function planStatusLine(v: PlanView): string {
	switch (planFlagOf(v)) {
		case "on":
			return `📋 ON (this console — ${v.planFile ?? "no file bound"}). finish_plan or /plan approve to implement, /plan reject [reason] to revise, /plan pause to suspend the write guard, /plan exit to leave.`;
		case "paused":
			return `⏸ PAUSED (this console — plan kept at ${v.planFile ?? "unbound"}). Writes are allowed again; the paused plan itself is not approved. /plan resume to keep planning, /plan exit to leave.`;
		case "off":
			return "off. Start with: /plan on [task]";
	}
}

/** Frame injected into every user message while planning is paused. */
export function planPausedFrame(v: PlanView): string {
	const file = v.planFile ?? "(no plan file bound)";
	return `[PLAN MODE PAUSED] Planning mode is PAUSED for this console: the plan at ${file} is kept but NOT approved. Normal work and normal writes are allowed again (the plan file is no longer special). Do not implement the paused plan itself and do not rewrite ${file} unless asked. When the side task is done, ask the user to run /plan resume to continue planning.`;
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

/** Appended to every planning kickoff so the approval dialog is actually reached. */
export function finishPlanReminder(): string {
	return "When the plan is complete, call the finish_plan tool with a short summary to present it for approval — don't just tell me it's done.";
}

/** Steer sent to a RUNNING turn when planning is paused, exited, or turned off mid-run. */
export function planningPausedSteer(file: string): string {
	return `Planning mode just got PAUSED for this console: the plan at ${file} is kept but unapproved, and the plan-file write guard is off — normal work and normal writes are allowed again. Do NOT implement the paused plan and do NOT rewrite ${file} unless the user asks. Do the side task, then tell the user to run /plan resume to continue planning.`;
}

/** Steer sent to a RUNNING turn when planning mode is exited (no implementation follows). */
export function planningExitedSteer(file: string): string {
	return `Planning mode just got EXITED for this console: the plan at ${file} is kept as a document but it is NOT approved. Do NOT implement it and do not call finish_plan again. Wrap up, summarize the plan briefly, and wait for a new instruction.`;
}
