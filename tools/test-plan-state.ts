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
	finishPlanReminder,
	planFlagOf,
	planFooterMarker,
	planGuardArmed,
	planPausedFrame,
	planStatusLine,
	planTitleMarker,
	planTransition,
	planningExitedSteer,
	planningPausedSteer,
	planningResumeText,
	planningRulesText,
	type PlanAction,
	type PlanView,
} from "../extensions/lib/plan-state.ts";
import { runAskLoop, type AskHost, type AskOptions, type DialogAnswer } from "../extensions/lib/ask-loop.ts";
import { DEFAULT_SESSION_STATE, loadSessionState, sessionStateFile, updateSessionState } from "../extensions/lib/session-state.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
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
	} finally {
		try { fs.rmSync(file, { force: true }); } catch { /* cleanup best-effort */ }
	}
})();

// ── 8. approval dialog rows (finish_plan needs "Keep planning" in row 2) ───
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
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
});
