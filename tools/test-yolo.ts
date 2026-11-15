/**
 * #14 regression test: yolo mode is a machine-global setting that cannot be
 * flipped by accident (new sessions, plan-mode exits, restarts).
 *
 * Run:  npx tsx tools/test-yolo.ts        (exit code 0 = all pass)
 *
 * This test WRITES guard/session state, so it must first prove it cannot reach the
 * real ~/.pi. The module derives its paths from os.homedir() at module-load time,
 * hence the temp-home redirect before the dynamic import — and on Windows os.homedir()
 * reads USERPROFILE, not HOME, so a HOME-only redirect used to leave the real
 * ~/.pi/agent/guard-state.json in play while the test believed it was sandboxed.
 * Both spellings are set now, and the first check verifies the module's OWN exported
 * paths landed under the temp home; if they did not, the write cases are refused
 * rather than run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (cond) console.log(`  PASS  ${name}`);
	else { failures++; console.error(`  FAIL  ${name}`); }
}

const HOME_BEFORE = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yolo-test-")));
process.env.HOME = tmpHome;
// Windows: os.homedir() → USERPROFILE (HOME is only a fallback). Setting both is
// harmless on Linux and is the difference between a sandboxed test and one that
// rewrites the developer's real guard state.
process.env.USERPROFILE = tmpHome;
// Clear the sandbox signals so cases start from a known baseline.
delete process.env.HUMBLE_PI_YOLO;
delete process.env.SANDBOX_NAME;

// Dynamic import (inside an async main) so the temp home is set before the module's
// top-level path constants are evaluated.
async function main(): Promise<void> {
const { loadGuardState, updateGuardState, loadSessionState, updateSessionState, sessionStateFile, GUARD_STATE_FILE, yoloDefaultOn } = await import("../extensions/lib/session-state");
// The test asserts against the module's own paths instead of re-deriving them — no
// second guess about what "home" means on this platform.
const GUARD_FILE = GUARD_STATE_FILE;

console.log("temp home is really in effect (write safety):");
check("GUARD_STATE_FILE is under the temp home", GUARD_FILE.startsWith(tmpHome), GUARD_FILE);
check("session-state files are under the temp home", sessionStateFile("probe-session").startsWith(tmpHome), sessionStateFile("probe-session"));
if (failures > 0) {
	// Refuse before writing anything: every case below calls updateGuardState/updateSessionState.
	console.error("\nREFUSING to run the write cases — os.homedir() did not move with the env redirect,");
	console.error(`so these writes would land on the real state under ${path.dirname(GUARD_FILE)}.`);
	fs.rmSync(tmpHome, { recursive: true, force: true });
	process.exit(1);
}

// Belt and braces: the ids this test writes, checked against the REAL session-state
// directory at the end. If the redirect ever stops working (a refactor that resolves
// home at call time, a new env spelling), this names the leak instead of hiding it.
const REAL_SESSION_STATE_DIR = path.join(fs.realpathSync(HOME_BEFORE), ".pi", "agent", "session-state");
const OUR_IDS = ["brand-new-session-id", "strip-check-session", "old-format-session", "probe-session"];
function straysInRealDir(): string[] {
	let files: string[];
	try { files = fs.readdirSync(REAL_SESSION_STATE_DIR); } catch { return []; }
	return files.filter((f) => OUR_IDS.some((id) => f.startsWith(id)));
}

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

check("nothing this test wrote landed in the real session-state dir", straysInRealDir().length === 0, straysInRealDir().join(", "));

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll yolo regression checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
