/**
 * #14 regression test: yolo mode is a machine-global setting that cannot be
 * flipped by accident (new sessions, plan-mode exits, restarts).
 *
 * Run:  npx tsx tools/test-yolo.ts        (exit code 0 = all pass)
 *
 * The module under test derives its paths from $HOME at call time, so we point
 * HOME at a temp dir BEFORE importing it — the real ~/.pi is never touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (cond) console.log(`  PASS  ${name}`);
	else { failures++; console.error(`  FAIL  ${name}`); }
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "yolo-test-"));
process.env.HOME = tmpHome;
// Clear the sandbox signals so cases start from a known baseline.
delete process.env.HUMBLE_PI_YOLO;
delete process.env.SANDBOX_NAME;

// Dynamic import (inside an async main) so $HOME is set before the module's
// top-level path constants are evaluated.
async function main(): Promise<void> {
const { loadGuardState, updateGuardState, loadSessionState, updateSessionState, sessionStateFile, yoloDefaultOn } = await import("../extensions/lib/session-state");
const GUARD_FILE = path.join(tmpHome, ".pi", "agent", "guard-state.json");

console.log("yoloDefaultOn():");
{
	const runSandboxDir = fs.existsSync("/run/sandbox"); // this machine may itself be a sandbox
	check(`baseline (env cleared) matches /run/sandbox presence (${runSandboxDir})`, yoloDefaultOn() === runSandboxDir);
	process.env.SANDBOX_NAME = "test-sbx";
	check("SANDBOX_NAME set → on", yoloDefaultOn() === true);
	delete process.env.SANDBOX_NAME;
	process.env.HUMBLE_PI_YOLO = "1";
	check("HUMBLE_PI_YOLO=1 → on", yoloDefaultOn() === true);
	delete process.env.HUMBLE_PI_YOLO;
}

console.log("global toggle sticks (across session ids, across plan-mode exits):");
{
	updateGuardState(s => { s.yoloMode = true; });
	check("explicit value persisted to guard-state.json", fs.existsSync(GUARD_FILE) && (JSON.parse(fs.readFileSync(GUARD_FILE, "utf8")) as any).yoloMode === true);
	// Simulate /new + leaving planning mode under a brand-new session id.
	updateSessionState("brand-new-session-id", s => { s.planMode = false; s.planFile = null; });
	check("still on after plan-mode-off RMW under a new session id", loadGuardState().yoloMode === true);
	updateGuardState(s => { s.yoloMode = false; });
	check("/guards yolo off sticks explicitly", loadGuardState().yoloMode === false);
}

console.log("one-way migration from legacy per-session files:");
{
	fs.rmSync(GUARD_FILE, { force: true });
	const legacyDir = path.join(tmpHome, ".pi", "agent", "session-state");
	fs.mkdirSync(legacyDir, { recursive: true });
	fs.writeFileSync(path.join(legacyDir, "old-session.json"), JSON.stringify({ planMode: false, planFile: null, unattendedMode: false, yoloMode: true }));
	check("missing guard file + legacy session yolo:true → migrated to on", loadGuardState().yoloMode === true);
	// An explicit global value always wins over migration.
	updateGuardState(s => { s.yoloMode = false; });
	fs.writeFileSync(path.join(legacyDir, "newer-session.json"), JSON.stringify({ planMode: false, planFile: null, unattendedMode: false, yoloMode: true }));
	check("explicit global value is never overwritten by migration", loadGuardState().yoloMode === false);
}

console.log("session-state files no longer carry yolo:");
{
	updateSessionState("strip-check-session", s => { s.planMode = true; });
	const raw = JSON.parse(fs.readFileSync(sessionStateFile("strip-check-session"), "utf8")) as Record<string, unknown>;
	check("save strips the legacy per-session yolo key", !("yoloMode" in raw) && raw.planMode === true);
	fs.writeFileSync(sessionStateFile("old-format-session"), JSON.stringify({ planMode: false, planFile: null, unattendedMode: false, yoloMode: true }));
	check("loading an old-format file works and ignores the legacy key", "yoloMode" in (loadSessionState("old-format-session") as object) === false);
}

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll yolo regression checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
