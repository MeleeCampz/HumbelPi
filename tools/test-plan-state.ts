/**
 * Regression test for the planning-mode state machine (extensions/lib/plan-state.ts) —
 * backlog #9's "two ways out that are not approval": PAUSE (plan kept, write guard
 * suspended, side work allowed) and EXIT (planning over, plan file kept, nothing
 * implemented), plus the RESUME that brings a paused plan back.
 *
 * Why a test at all: the whole design rests on PAUSED being stored as
 * `planMode:false + planPaused:true`, which is only safe if the transition table is the
 * single thing that decides mode changes. If any cell of that table is wrong, the damage is
 * invisible: a guard that stays armed (side tasks blocked) or one that silently disarms
 * (the model starts implementing an unapproved plan). Both read as "planning mode is weird".
 *
 * Also covered: the on-disk shape stays backward compatible (state files written before
 * planPaused existed must read as OFF/ON exactly as before), and the ask-loop keeps a
 * caller-listed `otherLabel` at its own ROW POSITION — the finish_plan dialog needs
 * "Keep planning" to stay 2nd while pause/exit come after it.
 *
 * Run: npx tsx tools/test-plan-state.ts        Exit 0 = all pass. No terminal, no pi runtime.
 */
import fs from "node:fs";
import {
	applyPlanTransition,
	consolePlanOf,
	consolePausedSteer,
	consoleExitedSteer,
	consolePlanningRulesText,
	finishPlanReminder,
	planCompletedOf,
	planExecutingFrame,
	planExecutingOf,
	planFinishedOf,
	planFlagOf,
	planFooterMarker,
	planGuardArmed,
	planLabel,
	planPanelVisibleOf,
	planPausedFrame,
	planStatusLine,
	planStyleForNewPlan,
	planStyleOf,
	planTitleMarker,
	planTransition,
	planningExitedSteer,
	planningPausedSteer,
	planningResumeText,
	planningRulesText,
	bindConsolePlanForStart,
	planRetiredOf,
	retiredPlanOf,
	type PlanAction,
	type PlanView,
} from "../extensions/lib/plan-state.ts";
import { applyPlanOp, newPlanDoc } from "../extensions/lib/plan-doc.ts";
import { runAskLoop, type AskHost, type AskOptions, type DialogAnswer } from "../extensions/lib/ask-loop.ts";
import { DEFAULT_SESSION_STATE, loadSessionState, sessionStateFile, updateSessionState } from "../extensions/lib/session-state.ts";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: string): void {
	checks++;
	if (cond) console.log(`  PASS  ${name}`);
	else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const st = (planMode: boolean, planPaused: boolean, planFile: string | null = "C:/plan/PLAN.md"): PlanView => ({ planMode, planPaused, planFile });
const ON = st(true, false);
const PAUSED = st(false, true);
const OFF = st(false, false, null); // nothing planned: no file bound either

/** Transition applied to a COPY (the table itself must never mutate its input). */
function applyState(v: PlanView, action: PlanAction): PlanView {
	const c = { ...v };
	applyPlanTransition(c, action);
	return c;
}

// ── 1. flag derivation ────────────────────────────────────────────────────
void (() => {
	console.log("flag derivation");
	check("planMode:true wins over planPaused (never both meanings)", planFlagOf(st(true, true)) === "on");
	check("planMode:false + planPaused → paused", planFlagOf(PAUSED) === "paused");
	check("planMode:false alone → off", planFlagOf(OFF) === "off");
	check("old state file without planPaused → off", planFlagOf({ planMode: false, planFile: null }) === "off");
})();

// ── 2. the whole transition table ─────────────────────────────────────────
type Row = { from: PlanView; action: PlanAction; ok: boolean; changed: boolean; flag: string; file: string | null };
const TABLE: Row[] = [
	{ from: ON, action: "on", ok: true, changed: false, flag: "on", file: "C:/plan/PLAN.md" },
	{ from: PAUSED, action: "on", ok: true, changed: true, flag: "on", file: "C:/plan/PLAN.md" },
	{ from: OFF, action: "on", ok: true, changed: true, flag: "on", file: null },

	{ from: ON, action: "pause", ok: true, changed: true, flag: "paused", file: "C:/plan/PLAN.md" },
	{ from: PAUSED, action: "pause", ok: true, changed: false, flag: "paused", file: "C:/plan/PLAN.md" },
	{ from: OFF, action: "pause", ok: false, changed: false, flag: "off", file: null },

	{ from: ON, action: "resume", ok: true, changed: false, flag: "on", file: "C:/plan/PLAN.md" },
	{ from: PAUSED, action: "resume", ok: true, changed: true, flag: "on", file: "C:/plan/PLAN.md" },
	{ from: OFF, action: "resume", ok: false, changed: false, flag: "off", file: null },

	{ from: ON, action: "approve", ok: true, changed: true, flag: "off", file: null },
	{ from: PAUSED, action: "approve", ok: false, changed: false, flag: "paused", file: "C:/plan/PLAN.md" },
	{ from: OFF, action: "approve", ok: false, changed: false, flag: "off", file: null },

	{ from: ON, action: "exit", ok: true, changed: true, flag: "off", file: "C:/plan/PLAN.md" },
	{ from: PAUSED, action: "exit", ok: true, changed: true, flag: "off", file: "C:/plan/PLAN.md" },
	{ from: OFF, action: "exit", ok: true, changed: false, flag: "off", file: null },
];

void (() => {
	console.log("transition table");
	for (const r of TABLE) {
		const t = planTransition(r.from, r.action);
		const label = `${r.action} from ${planFlagOf(r.from).toUpperCase().padEnd(6)}`;
		check(`${label} → ${r.flag}${r.changed ? "" : " (no change)"}${r.ok ? "" : " [refused]"}`,
			t.ok === r.ok && t.changed === r.changed && t.flag === r.flag && t.file === r.file,
			`got ok=${t.ok} changed=${t.changed} flag=${t.flag} file=${t.file}`);
		check(`${label} explains itself`, typeof t.reason === "string" && t.reason.length > 5);
	}
	// The two ways out must not collapse into each other: approve unbinds the plan file,
	// exit keeps it (that file is the document the user asked for).
	check("approve unbinds the plan file", planTransition(ON, "approve").file === null);
	check("exit KEEPS the plan file", planTransition(ON, "exit").file === "C:/plan/PLAN.md");
	check("exit from PAUSED keeps it too", planTransition(PAUSED, "exit").file === "C:/plan/PLAN.md");
	// Pause/resume are about the SAME plan, not a new one.
	check("pause keeps the pinned file", planTransition(ON, "pause").file === "C:/plan/PLAN.md");
	check("resume keeps the pinned file", planTransition(PAUSED, "resume").file === "C:/plan/PLAN.md");
	// A refused action must not pretend to change anything.
	check("pause from OFF is refused", planTransition(OFF, "pause").ok === false && planTransition(OFF, "pause").changed === false);
	check("resume from OFF is refused", planTransition(OFF, "resume").ok === false);
	check("approve from PAUSED is refused (paused plan is not an approved plan)", planTransition(PAUSED, "approve").ok === false);
})();

// ── 3. applyPlanTransition mutates the state the table promises ───────────
void (() => {
	console.log("applyPlanTransition (on-disk shape)");
	const a = st(true, false);
	applyPlanTransition(a, "pause");
	check("pause writes planMode:false + planPaused:true", a.planMode === false && a.planPaused === true, JSON.stringify(a));
	check("pause keeps planFile", a.planFile === "C:/plan/PLAN.md");
	applyPlanTransition(a, "resume");
	check("resume writes planMode:true + planPaused:false", a.planMode === true && a.planPaused === false, JSON.stringify(a));
	applyPlanTransition(a, "exit");
	check("exit clears both flags but KEEPS the file", a.planMode === false && a.planPaused === false && a.planFile === "C:/plan/PLAN.md", JSON.stringify(a));
	applyPlanTransition(a, "on");
	check("on from OFF re-binds nothing and re-arms the kept file", a.planMode === true && a.planFile === "C:/plan/PLAN.md");
	applyPlanTransition(a, "approve");
	check("approve clears the file too", a.planMode === false && a.planPaused === false && a.planFile === null, JSON.stringify(a));
	const b = st(false, true);
	applyPlanTransition(b, "approve");
	check("refused action mutates nothing", b.planMode === false && b.planPaused === true && b.planFile === "C:/plan/PLAN.md", JSON.stringify(b));
	check("planTransition does not mutate its input", (() => { const v = { ...ON }; planTransition(v, "approve"); return v.planMode === true && v.planFile === "C:/plan/PLAN.md"; })());
})();

// ── 4. the guard-relevant consequence of PAUSE ────────────────────────────
void (() => {
	console.log("what pause actually changes");
	check("paused console: plan-file guard DISARMED", planGuardArmed(PAUSED) === false);
	check("planning console: plan-file guard ARMED", planGuardArmed(ON) === true);
	check("off console: not armed either", planGuardArmed(OFF) === false);
	check("approve disarms", planGuardArmed(applyState(ON, "approve")) === false);
	check("exit disarms", planGuardArmed(applyState(ON, "exit")) === false);
	check("resume re-arms", planGuardArmed(applyState(PAUSED, "resume")) === true);
	const frame = planPausedFrame(PAUSED);
	check("paused frame is injected as a bracketed marker", frame.startsWith("[PLAN MODE PAUSED]"));
	check("paused frame names the kept plan file", frame.includes("C:/plan/PLAN.md"));
	check("paused frame forbids implementing the paused plan", /do not implement the paused plan/i.test(frame));
	check("paused frame names the resume command", frame.includes("/plan resume"));
})();

// ── 5. presentation markers (title / footer / status share one source) ────
void (() => {
	console.log("markers and status line");
	check("title marker ON", planTitleMarker(ON) === "📋 PLAN");
	check("title marker PAUSED is visibly different", planTitleMarker(PAUSED) === "📋 PLAN ⏸");
	check("title marker OFF is absent", planTitleMarker(OFF) === null);
	check("footer marker ON", planFooterMarker(ON) === "📋");
	check("footer marker PAUSED", planFooterMarker(PAUSED) === "📋⏸");
	check("footer marker OFF is absent", planFooterMarker(OFF) === null);
	check("/plan status names pause and exit when ON", planStatusLine(ON).includes("/plan pause") && planStatusLine(ON).includes("/plan exit"));
	check("/plan status when PAUSED says writes are allowed", planStatusLine(PAUSED).includes("Writes are allowed again"));
	check("/plan status when PAUSED offers resume and exit", planStatusLine(PAUSED).includes("/plan resume") && planStatusLine(PAUSED).includes("/plan exit"));
	check("/plan status OFF unchanged wording", planStatusLine(OFF).startsWith("off."));
})();

// ── 6. model-facing instructions (the ones that used to be duplicated) ────
void (() => {
	console.log("model-facing text");
	check("rules text pins the plan file", planningRulesText("C:/plan/PLAN.md").includes("only file you may create or modify is C:/plan/PLAN.md"));
	check("resume text says keep, not restart", planningResumeText("C:/plan/PLAN.md").includes("keep revising the plan that is already there"));
	check("every planning kickoff ends with the finish_plan reminder", finishPlanReminder().includes("finish_plan"));
	check("pause steer tells the running turn to stop writing the plan file", planningPausedSteer("C:/plan/PLAN.md").includes("do NOT rewrite C:/plan/PLAN.md"));
	check("exit steer forbids implementing", planningExitedSteer("C:/plan/PLAN.md").includes("Do NOT implement"));
})();

// ── 7. session-state round trip (disk is the truth, per #1/#4) ────────────
void (() => {
	console.log("session state on disk");
	const sid = `test-plan-state-${Date.now()}`;
	const file = sessionStateFile(sid);
	try {
		updateSessionState(sid, s => { s.planMode = true; s.planFile = "C:/plan/PLAN.md"; });
		check("ON survives a reload", planFlagOf(loadSessionState(sid)) === "on");
		updateSessionState(sid, s => { applyPlanTransition(s, "pause"); });
		const after = loadSessionState(sid);
		check("PAUSE survives a reload", planFlagOf(after) === "paused", JSON.stringify(after));
		check("paused file keeps its plan file on disk", after.planFile === "C:/plan/PLAN.md");
		check("paused file is written as planMode:false (existing gates stay OFF-shaped)", after.planMode === false);
		updateSessionState(sid, s => { applyPlanTransition(s, "resume"); });
		check("RESUME survives a reload", planFlagOf(loadSessionState(sid)) === "on");
		updateSessionState(sid, s => { applyPlanTransition(s, "exit"); });
		const exited = loadSessionState(sid);
		check("EXIT survives a reload as off + kept file", planFlagOf(exited) === "off" && exited.planFile === "C:/plan/PLAN.md", JSON.stringify(exited));
		// A state file written by an OLDER build (no planPaused key at all) must still load.
		fs.writeFileSync(file, JSON.stringify({ planMode: false, planFile: "C:/old/PLAN.md", unattendedMode: true }));
		const legacy = loadSessionState(sid);
		check("legacy file (no planPaused) loads as off", planFlagOf(legacy) === "off");
		check("legacy file keeps its other fields", legacy.unattendedMode === true && legacy.planFile === "C:/old/PLAN.md");
		check("legacy file gets planPaused:false, not undefined", legacy.planPaused === DEFAULT_SESSION_STATE.planPaused);
		check("legacy plan file is not lost on upgrade (/plan on re-binds it, exit semantics survive)", (() => { const v = applyState(legacy, "on"); return v.planMode === true && v.planFile === "C:/old/PLAN.md"; })());
		check("a legacy OFF state still refuses pause (nothing planned)", planFlagOf(applyState(legacy, "pause")) === "off");

		// #16: the console plan is a state object, so it has to survive the same round trip a file does.
		const cdoc = applyPlanOp(newPlanDoc({ title: "Round trip", task: "t" }), { action: "add", text: "do it" }).doc;
		updateSessionState(sid, s => {
			s.planStyle = "tui"; s.planDoc = cdoc; s.planFile = null;
			applyPlanTransition(s, "on");
		});
		const back = loadSessionState(sid);
		check("console plan survives a reload (style + mode)", planStyleOf(back) === "tui" && planFlagOf(back) === "on", JSON.stringify({ style: back.planStyle, mode: back.planMode }));
		check("the reloaded plan keeps its steps and their stable ids", consolePlanOf(back)?.steps[0]?.id === cdoc.steps[0]?.id && consolePlanOf(back)?.steps[0]?.text === "do it", JSON.stringify(consolePlanOf(back)?.steps));
		updateSessionState(sid, s => { applyPlanTransition(s, "approve"); });
		const approved = loadSessionState(sid);
		check("approval survives a reload as off + executing + kept plan", planFlagOf(approved) === "off" && planExecutingOf(approved) && consolePlanOf(approved) !== null, JSON.stringify({ mode: approved.planMode, exec: approved.planExecuting }));
		// A corrupt/hand-edited planDoc must read as NO plan, not as a half-plan.
		fs.writeFileSync(file, JSON.stringify({ planMode: true, planPaused: false, planFile: null, planStyle: "tui", planDoc: { steps: [{ text: 12345 }] } }));
		const broken = loadSessionState(sid);
		check("an unusable planDoc coerces to no plan", consolePlanOf(broken) === null, JSON.stringify(broken.planDoc));
		check("and planning mode drops instead of running with nothing planned", planFlagOf(broken) === "off", JSON.stringify({ mode: broken.planMode, paused: broken.planPaused }));
		// A state file written before #16 must read exactly as it did then.
		fs.writeFileSync(file, JSON.stringify({ planMode: false, planPaused: true, planFile: "C:/old2/PLAN.md" }));
		const legacy2 = loadSessionState(sid);
		check("legacy file (no planStyle/planDoc) reads as file mode", planStyleOf(legacy2) === "file" && consolePlanOf(legacy2) === null);
		check("legacy paused plan still pauses/resumes unchanged", planFlagOf(legacy2) === "paused" && planFlagOf(applyState(legacy2, "resume")) === "on" && applyState(legacy2, "resume").planFile === "C:/old2/PLAN.md");
		check("legacy state never claims executing", planExecutingOf(legacy2) === false);
		// #16 coercion: executing is a console-mode fact — file mode cannot carry it.
		fs.writeFileSync(file, JSON.stringify({ planMode: false, planPaused: false, planFile: "C:/plan/PLAN.md", planStyle: "file", planExecuting: true }));
		const badExec = loadSessionState(sid);
		check("executing is coerced off in file mode", planExecutingOf(badExec) === false, JSON.stringify(badExec.planExecuting));
		fs.writeFileSync(file, JSON.stringify({ planMode: false, planPaused: false, planFile: null, planStyle: "tui", planDoc: null, planExecuting: true }));
		const execNoDoc = loadSessionState(sid);
		check("executing with no plan document reads as off", planExecutingOf(execNoDoc) === false, JSON.stringify(execNoDoc.planExecuting));
	} finally {
		try { fs.rmSync(file, { force: true }); } catch { /* cleanup best-effort */ }
	}
})();

// ── 8. #16 CONSOLE plan mode: the style flag, the executing flag, the wording ───
void (() => {
	console.log("console plan mode (#16)");
	const doc = applyPlanOp(applyPlanOp(newPlanDoc({ title: "Console plan", task: "do the thing" }), { action: "add", text: "step one" }).doc, { action: "add", text: "step two" }).doc;
	const tuiOn: PlanView = { planMode: true, planPaused: false, planFile: null, planStyle: "tui", planDoc: doc };
	const fileOn: PlanView = { planMode: true, planPaused: false, planFile: "C:/plan/PLAN.md" };

	check("a bound planDoc makes the console a CONSOLE-plan console", planStyleOf(tuiOn) === "tui");
	check("a pinned plan file stays FILE mode (old states unchanged)", planStyleOf(fileOn) === "file");
	check("consolePlanOf returns the document in console mode", consolePlanOf(tuiOn)?.steps.length === 2);
	check("consolePlanOf returns null in file mode", consolePlanOf(fileOn) === null);

	// Which style a NEW plan uses — /plan on and the backlog row must agree by construction.
	check("an existing console plan wins over the machine file default", planStyleForNewPlan(tuiOn, "file") === "tui");
	check("an existing plan file wins over the machine console default", planStyleForNewPlan(fileOn, "tui") === "file");
	check("only a console with no plan anywhere consults the machine default", planStyleForNewPlan({ planMode: false, planPaused: false, planFile: null }, "tui") === "tui");
	check("and defaults to file mode when the machine said nothing", planStyleForNewPlan({ planMode: false, planPaused: false, planFile: null }, undefined) === "file");

	// Approve is the one transition that differs between the styles.
	const tuiApprove = planTransition(tuiOn, "approve");
	check("console approve ends planning mode", tuiApprove.ok && tuiApprove.flag === "off");
	check("console approve sets EXECUTING (the checklist must keep tracking)", tuiApprove.executing === true);
	const fileApprove = planTransition(fileOn, "approve");
	check("file approve does NOT set executing (the file mode never had a live checklist)", fileApprove.executing === false);
	const executed: PlanView = { planMode: false, planPaused: false, planFile: null, planStyle: "tui", planDoc: doc, planExecuting: true };
	check("planExecutingOf reads the flag", planExecutingOf(executed) === true);
	check("executing is off before approval", planExecutingOf(tuiOn) === false);
	check("an executing console is NOT in planning mode (writes are allowed again)", planFlagOf(executed) === "off" && planGuardArmed(executed) === false);
	check("executing frame names the plan and its progress", (planExecutingFrame(executed) ?? "").includes("PLAN IMPLEMENTING") && (planExecutingFrame(executed) ?? "").includes("0/2"), planExecutingFrame(executed)?.slice(0, 60));
	check("no executing frame without the flag", planExecutingFrame(tuiOn) === null);

	// ── #18: a FINISHED plan stops claiming to be implementing ────────────────────
	{
		let d2 = applyPlanOp(applyPlanOp(newPlanDoc({ title: "Console plan", task: "t" }), { action: "add", text: "step one" }).doc, { action: "add", text: "step two" }).doc;
		d2 = applyPlanOp(d2, { action: "status", id: 1, status: "done" }).doc;
		const half: PlanView = { planMode: false, planPaused: false, planFile: null, planStyle: "tui", planDoc: d2, planExecuting: true };
		check("a half-finished console is still implementing", planCompletedOf(half) === false && planPanelVisibleOf(half) === true, planStatusLine(half));
		check("and still says so in the frame, the title and the footer", planExecutingFrame(half) !== null && planTitleMarker(half) === "📋 CONSOLE PLAN ▶" && planFooterMarker(half) === "📋▶");
		d2 = applyPlanOp(d2, { action: "status", id: 2, status: "dropped" }).doc;
		const fin: PlanView = { ...half, planDoc: d2 };
		check("done + dropped counts as finished", planCompletedOf(fin) === true, planStatusLine(fin));
		check("planFinishedOf is the one-shot moment a completion may be announced", planFinishedOf(fin) === true && planFinishedOf(half) === false);
		check("the [PLAN IMPLEMENTING] frame goes silent", planExecutingFrame(fin) === null, planExecutingFrame(fin) ?? "");
		check("the 📋▶ title and footer drop", planTitleMarker(fin) === null && planFooterMarker(fin) === null, `${planTitleMarker(fin)} / ${planFooterMarker(fin)}`);
		check("the panel is no longer visible", planPanelVisibleOf(fin) === false);
		check("the status line reports a finished plan, not 'off'", planStatusLine(fin).includes("COMPLETE"), planStatusLine(fin));
		const cleared: PlanView = { ...fin, planExecuting: false };
		check("a cleared flag still reads as a finished plan", planCompletedOf(cleared) === true && planExecutingOf(cleared) === false);
		const reopened = applyPlanOp(d2, { action: "status", id: 2, status: "open" }).doc;
		const back: PlanView = { ...fin, planDoc: reopened };
		check("re-opening a step un-finishes the plan (and its panel)", planCompletedOf(back) === false && planPanelVisibleOf(back) === true);
		check("planning and paused plans always keep the panel", planPanelVisibleOf(tuiOn) === true && planPanelVisibleOf({ ...tuiOn, planMode: false, planPaused: true }) === true);
		check("file mode has no live panel to hide", planPanelVisibleOf(fileOn) === false && planCompletedOf(fileOn) === false);
		check("an approved plan with no steps is not 'complete'", planCompletedOf({ planMode: false, planPaused: false, planFile: null, planStyle: "tui", planDoc: newPlanDoc({ title: "empty" }), planExecuting: true }) === false);
	}

	// Pause/resume are IDENTICAL in both styles — only the wording differs.
	const tuiPause = planTransition(tuiOn, "pause");
	check("console pause pauses like everything else", tuiPause.ok && tuiPause.flag === "paused");
	check("console pause keeps the document bound", tuiPause.file === null && planStyleOf(tuiOn) === "tui");
	check("paused console frame says PAUSED + kept + writes allowed", planPausedFrame(tuiOn).includes("PAUSED") && planPausedFrame(tuiOn).includes("console plan"), planPausedFrame(tuiOn).slice(0, 80));
	check("paused FILE frame still names the file", planPausedFrame(fileOn).includes("C:/plan/PLAN.md"));
	check("console paused steer forbids rebuilding the plan", consolePausedSteer(tuiOn).includes("do NOT call plan_doc") && consolePausedSteer(tuiOn).includes("/plan resume"), consolePausedSteer(tuiOn).slice(0, 60));
	check("console exited steer keeps the plan but forbids implementing", /is kept/.test(consoleExitedSteer(tuiOn)) && /do NOT implement/i.test(consoleExitedSteer(tuiOn)), consoleExitedSteer(tuiOn).slice(0, 60));
	check("file exited steer still names the file", planningExitedSteer("C:/plan/PLAN.md").includes("C:/plan/PLAN.md"));

	// Presentation: one source for both styles, different names.
	check("title marker says CONSOLE PLAN in console mode", (planTitleMarker(tuiOn) ?? "").includes("CONSOLE PLAN"), planTitleMarker(tuiOn) ?? "");
	check("title marker stays 📋 PLAN in file mode", (planTitleMarker(fileOn) ?? "").includes("PLAN") && !(planTitleMarker(fileOn) ?? "").includes("CONSOLE"), planTitleMarker(fileOn) ?? "");
	check("footer marker is the same single cell in both styles", planFooterMarker(tuiOn) === "📋" && planFooterMarker(fileOn) === "📋", `${planFooterMarker(tuiOn)} / ${planFooterMarker(fileOn)}`);
	check("an implementing console shows the ▶ footer cell", planFooterMarker(executed) === "📋▶", planFooterMarker(executed) ?? "");
	check("status line names the console plan, not a file", planStatusLine(tuiOn).includes("console plan"), planStatusLine(tuiOn));
	check("planLabel quotes the plan title and its progress", planLabel(tuiOn).includes("Console plan") && planLabel(tuiOn).includes("2 steps"), planLabel(tuiOn));

	// Model-facing rules text: console mode must NOT talk about a file it does not have.
	const rules = consolePlanningRulesText(doc);
	check("console rules forbid every write (no exempt file)", rules.includes("do not write ANY file"), rules.slice(0, 80));
	check("console rules point at plan_doc", rules.includes("plan_doc"));
	check("console rules still end at finish_plan's reminder", rules.includes("ask_user tool"));
	check("console rules never mention a plan file path", !/\.md/.test(rules), rules.match(/\.md/)?.[0] ?? "");
	check("the file-mode rules are unchanged (both modes coexist)", planningRulesText("C:/plan/PLAN.md").includes("C:/plan/PLAN.md") && planningResumeText("f").includes("RESUMED"));
	check("the finish_plan reminder is shared by both styles", finishPlanReminder().includes("finish_plan"));
})();

// ── 8b. #22: a FINISHED plan is retired when a new plan starts ───────────────
void (() => {
	console.log("retiring a finished plan (#22)");

	// A finished checklist that nothing is implementing any more (the state the user walked into).
	let done = newPlanDoc({ title: "Old plan", task: "the old request" });
	done = applyPlanOp(done, { action: "add", text: "first" }).doc;
	done = applyPlanOp(done, { action: "status", id: 1, status: "done" }).doc;
	const staleOn: PlanView = { planMode: true, planPaused: false, planFile: null, planStyle: "tui", planDoc: done };
	const staleOff: PlanView = { ...staleOn, planMode: false };
	const paused: PlanView = { ...staleOn, planMode: false, planPaused: true };
	const executing: PlanView = { ...staleOff, planDoc: done, planExecuting: true };
	const half = applyPlanOp(done, { action: "status", id: 1, status: "open" }).doc;
	const draft: PlanView = { planMode: true, planPaused: false, planFile: null, planStyle: "tui", planDoc: half };

	check("a finished, idle plan reads as RETIRED", planRetiredOf(staleOff) === true);
	check("and a finished plan still bound to planning mode reads as retired too (the bug you walked into)", planRetiredOf(staleOn) === true);
	check("a plan mid-implementation is never retired", planRetiredOf(executing) === false);
	check("a half-drafted plan is never retired", planRetiredOf(draft) === false);
	check("an empty plan is never retired (nothing to archive)", planRetiredOf({ planMode: false, planPaused: false, planFile: null, planStyle: "tui", planDoc: newPlanDoc({ title: "empty" }) }) === false);
	check("file mode has no document to retire", planRetiredOf({ planMode: true, planFile: "C:/plan/PLAN.md" }) === false);

	// The bind rule every entry point shares.
	const freshFromStale = bindConsolePlanForStart(staleOff, { task: "new request", title: "New plan" });
	check("a fresh start over a finished plan binds an EMPTY document", freshFromStale.doc.steps.length === 0, JSON.stringify(freshFromStale.doc.steps));
	check("the new document carries THIS task, not the old one", freshFromStale.doc.task === "new request" && freshFromStale.doc.title === "New plan", `${freshFromStale.doc.title} / ${freshFromStale.doc.task}`);
	check("and the finished plan is handed back to be archived", freshFromStale.retired === done);
	const freshFromDraft = bindConsolePlanForStart(draft, { task: "another request", title: "Another" });
	check("a draft is KEPT — starting never destroys work in progress", freshFromDraft.doc === half && freshFromDraft.retired === null);
	const freshFromPaused = bindConsolePlanForStart(paused, { task: "t", title: "T" });
	check("a paused plan keeps its document whatever its step statuses", freshFromPaused.doc === done && freshFromPaused.retired === null);
	const freshFromNothing = bindConsolePlanForStart({ planMode: false, planPaused: false, planFile: null, planStyle: "tui", planDoc: null }, { task: "t", title: "T" });
	check("nothing bound binds a fresh document, and archives nothing", freshFromNothing.doc.steps.length === 0 && freshFromNothing.retired === null);
	const resetOnDraft = bindConsolePlanForStart(draft, { task: "t", title: "T" }, { keepDraft: false });
	check("plan_doc reset clears a live draft (and archives nothing)", resetOnDraft.doc.steps.length === 0 && resetOnDraft.retired === null);
	const resetOnFinished = bindConsolePlanForStart(staleOff, { task: "t", title: "T" }, { keepDraft: false });
	check("but a reset ARCHIVES a finished plan instead of dropping it", resetOnFinished.retired === done && resetOnFinished.doc.steps.length === 0);
	const titleFromTask = bindConsolePlanForStart(staleOff, { task: "a long request that has to become the title" });
	check("a title falls back to the task text, cut to 80 columns", titleFromTask.doc.title === "a long request that has to become the title", titleFromTask.doc.title);

	// The archive is a separate document, reachable only through its own accessor.
	check("retiredPlanOf reads the archive, not the live plan", retiredPlanOf({ ...staleOff, planDoc: half, planDocPrevious: done }) === done);
	check("with no archive it says so", retiredPlanOf(staleOff) === null);
	check("file mode has no archive", retiredPlanOf({ ...staleOff, planStyle: "file", planDocPrevious: done }) === null);
	check("the archive never makes a plan visible in the panel", planPanelVisibleOf({ ...staleOff, planDoc: null, planDocPrevious: done }) === false);

	// Disk: the archive survives exactly like the plan does.
	const sid = `test-plan-retire-${Date.now()}`;
	const file = sessionStateFile(sid);
	try {
		updateSessionState(sid, s => {
			s.planStyle = "tui"; s.planFile = null;
			s.planDoc = done;
			s.planDocPrevious = null;
			applyPlanTransition(s, "on");
			const bound = bindConsolePlanForStart(s, { task: "new request", title: "New plan" });
			s.planDoc = bound.doc;
			if (bound.retired) s.planDocPrevious = bound.retired;
		});
		const back = loadSessionState(sid);
		check("the retired plan survives a reload in its own field", retiredPlanOf(back)?.steps[0]?.text === "first", JSON.stringify(retiredPlanOf(back)?.steps));
		check("while the live plan is the fresh one", consolePlanOf(back)?.steps.length === 0 && consolePlanOf(back)?.task === "new request", JSON.stringify(consolePlanOf(back)?.task));
		check("the archive is not mistaken for the console's plan", planRetiredOf(back) === false, planStatusLine(back));
		// Exit keeps both: the fresh plan and its archive.
		updateSessionState(sid, s => { applyPlanTransition(s, "exit"); });
		const exited = loadSessionState(sid);
		check("/plan exit keeps the archive too", retiredPlanOf(exited)?.steps[0]?.text === "first" && consolePlanOf(exited)?.steps.length === 0);
		// A hand-edited / corrupt archive must read as NO archive, never as a half one.
		fs.writeFileSync(file, JSON.stringify({ planMode: true, planPaused: false, planFile: null, planStyle: "tui", planDoc: half, planDocPrevious: { steps: [{ text: 99999 }] } }));
		const corrupt = loadSessionState(sid);
		check("a corrupt archive coerces to no archive", retiredPlanOf(corrupt) === null, JSON.stringify(corrupt.planDocPrevious));
		check("and it never drops planning mode over a plan that is only missing an archive", planFlagOf(corrupt) === "on" && consolePlanOf(corrupt) !== null, planFlagOf(corrupt));
		// An archive with NO live plan must not be read as "a plan is bound".
		fs.writeFileSync(file, JSON.stringify({ planMode: true, planPaused: false, planFile: null, planStyle: "tui", planDoc: null, planDocPrevious: done }));
		const archiveOnly = loadSessionState(sid);
		check("archive alone does not count as a bound plan (planning mode drops, as before)", planFlagOf(archiveOnly) === "off" && consolePlanOf(archiveOnly) === null);
		check("but the archive itself is still readable after that", retiredPlanOf(archiveOnly)?.steps[0]?.text === "first", JSON.stringify(retiredPlanOf(archiveOnly)));
		// Old state files (no such key) load unchanged.
		fs.writeFileSync(file, JSON.stringify({ planMode: false, planPaused: false, planFile: "C:/old/PLAN.md" }));
		check("a legacy state file reads with no archive", retiredPlanOf(loadSessionState(sid)) === null);
	} finally {
		try { fs.rmSync(file, { force: true }); } catch { /* cleanup */ }
	}
})();

// ── 9. approval dialog rows (finish_plan needs "Keep planning" in row 2) ───
async function dialogRows(): Promise<void> {
	console.log("approval dialog rows");
	const APPROVE = "✅ Approve & implement";
	const KEEP = "✏️ Keep planning";
	const PAUSE = "⏸ Pause planning (side task)";
	const EXIT = "🚪 Exit planning (keep file)";
	const FEEDBACK = "use SQLite instead";
	const BASE: AskOptions = {
		question: "Plan ready?",
		options: [APPROVE, KEEP, PAUSE, EXIT],
		otherLabel: KEEP, // the caller lists it in position 2 on purpose (it is the Esc reflex answer)
		answerTitle: "What should change?",
		answerPlaceholder: "…",
	};
	const seen: string[][] = [];
	const script: DialogAnswer[] = [{ text: FEEDBACK, back: true }, { text: FEEDBACK, back: false }];
	const host: AskHost = {
		select: async (_q, options) => { seen.push([...options]); return options[1]; },
		answer: async () => script.shift() as DialogAnswer,
	};
	const outcome = await runAskLoop(host, BASE);
	const list = seen[0]!;
	check("all four rows are offered in the caller's order", list.length === 4 && list[0] === APPROVE && list[1] === KEEP && list[2] === PAUSE && list[3] === EXIT, list.join(" | "));
	check("otherLabel keeps its listed position instead of being re-appended last", list[1] === KEEP, list.join(" | "));
	check("otherLabel is never shown twice", list.filter((x) => x === KEEP).length === 1, list.join(" | "));
	check("typing feedback + picking Keep planning returns the text", outcome.kind === "custom" && outcome.text === FEEDBACK, JSON.stringify(outcome));
	check("the list re-appears identical after an Esc from the feedback box", seen.length === 2 && seen[1]!.join("|") === list.join("|"), seen.map((l) => l.join(" | ")).join(" // "));
}

// The async section must finish before the verdict is printed — otherwise a passing-looking
// run could exit 0 with the dialog checks never evaluated.
void dialogRows().then(() => {
	console.log(failures === 0 ? `ALL PASS (${checks} checks)` : `\n${failures} of ${checks} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
});
