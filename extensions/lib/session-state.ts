/**
 * Shared agent-state IO (schema owner for both files).
 *
 * Two state files, one rule: every save is a read-modify-write against FRESH disk
 * content (update*), and every write is atomic (tmp + rename) so a reader never
 * sees a partial file.
 *
 *   • session-state/<sessionId>.json — per console/session: plan mode, unattended, yolo.
 *   • guard-state.json               — machine-global: sandbox/push guards + grants.
 *
 * Yolo default: when HUMBLE_PI_YOLO=1 (baked into sbxpi sandboxes by tools/sbx-pi.sh
 * via `sbx create --env`) sessions WITHOUT a state file yet start with yoloMode ON —
 * the container is already the isolation boundary. A /guards yolo off persists to the
 * session file and keeps winning for that session.
 *
 * Why no mtime caches here (backlog #1): the files are ~100 bytes, reads are cheap
 * even at footer-render frequency, and stale-snapshot write-backs (load → await a
 * dialog → save the old object) used to resurrect planMode / clobber grants.
 *
 * This file is a plain helper module — it is EXCLUDED from extension auto-loading
 * (package.json "pi.extensions" negation) and must not register anything itself.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── per-session state (plan + unattended + yolo) — #4 ────────────────────
const SESSION_STATE_DIR = path.join(os.homedir(), ".pi", "agent", "session-state");

export interface SessionState {
	planMode: boolean;
	planFile: string | null;
	unattendedMode: boolean;
	yoloMode: boolean;
}

export const DEFAULT_SESSION_STATE: SessionState = { planMode: false, planFile: null, unattendedMode: false, yoloMode: false };

/**
 * Yolo default: tools/sbx-pi.sh bakes HUMBLE_PI_YOLO=1 into the sandbox at create
 * time (`sbx create --env`) — there the container IS the isolation boundary, so the
 * path-sandbox guard is redundant and new sessions start with yolo mode ON.
 */
const YOLO_DEFAULT_ON = process.env.HUMBLE_PI_YOLO === "1";

/** Defaults for a session with no state file yet: yolo ON when HUMBLE_PI_YOLO=1. */
function freshSessionState(): SessionState {
	return { ...DEFAULT_SESSION_STATE, yoloMode: YOLO_DEFAULT_ON };
}

let sessionStatePruned = false;

/** Delete session-state files not touched in 30 days (no session_end event to hook). */
function pruneOldSessionState(): void {
	if (sessionStatePruned) return;
	sessionStatePruned = true;
	try {
		const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
		for (const f of fs.readdirSync(SESSION_STATE_DIR)) {
			if (!f.endsWith(".json")) continue;
			const p = path.join(SESSION_STATE_DIR, f);
			try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* keep going */ }
		}
	} catch { /* dir missing — nothing to prune */ }
}

export function sessionStateFile(sessionId: string): string {
	return path.join(SESSION_STATE_DIR, `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

/** Fresh read — defaults when the file is missing or corrupt. Never cached. */
export function loadSessionState(sessionId: string): SessionState {
	pruneOldSessionState();
	try {
		const s = JSON.parse(fs.readFileSync(sessionStateFile(sessionId), "utf8"));
		return { ...freshSessionState(), ...s };
	} catch {
		return freshSessionState();
	}
}

/**
 * Atomic write (tmp + rename) so concurrent readers never see a partial file.
 * Mirrors the de-facto standard npm/write-file-atomic: unique sibling tmp name
 * (pid-disambiguated), fsync BEFORE the rename for crash durability, and tmp
 * cleanup on failure. Synchronous by design — the files are ~100 bytes and pi's
 * extension hooks here render synchronously anyway.
 */
function atomicWriteJson(file: string, data: unknown): void {
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		const fd = fs.openSync(tmp, "w");
		try {
			fs.writeSync(fd, JSON.stringify(data));
			fs.fsyncSync(fd); // flush to disk before the rename — a crash in between must not leave an empty target
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* already gone */ }
		throw err;
	}
}

/** Plain save of a full state object (callers that already hold the desired state). */
export function saveSessionState(sessionId: string, s: SessionState): void {
	fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
	atomicWriteJson(sessionStateFile(sessionId), s);
}

/**
 * Read-modify-write against FRESH disk content: load → mutate(s) → save.
 * Use this for every mutation so a stale in-memory snapshot (e.g. loaded before an
 * awaited user dialog) can never resurrect or clobber fields written meanwhile.
 * Returns the saved state.
 */
export function updateSessionState(sessionId: string, mutate: (s: SessionState) => void): SessionState {
	const s = loadSessionState(sessionId);
	mutate(s);
	saveSessionState(sessionId, s);
	return s;
}

// ── machine-global guard state (sandbox + push grants) ───────────────────
export const GUARD_STATE_FILE = path.join(os.homedir(), ".pi", "agent", "guard-state.json");

export interface GuardState {
	sandboxEnabled: boolean;
	pushGuardEnabled: boolean;
	allowedPaths: string[];
	readOnlyPaths: string[];
	allowedBranches: string[];
	/** Shift-select in the input editor (select-editor.ts). Defaults ON. */
	selectionMode?: boolean;
}

export const DEFAULT_GUARD_STATE: GuardState = {
	sandboxEnabled: true,
	pushGuardEnabled: true,
	allowedPaths: [],
	readOnlyPaths: [],
	allowedBranches: [],
	selectionMode: true,
};

/** Fresh read of the global guard state — defaults when missing or corrupt. Never cached. */
export function loadGuardState(): GuardState {
	try {
		const s = { ...DEFAULT_GUARD_STATE, ...JSON.parse(fs.readFileSync(GUARD_STATE_FILE, "utf8")) };
		if (!Array.isArray(s.readOnlyPaths)) s.readOnlyPaths = [];
		return s;
	} catch {
		return { ...DEFAULT_GUARD_STATE, allowedPaths: [], readOnlyPaths: [], allowedBranches: [] };
	}
}

/**
 * Read-modify-write of the global guard state against FRESH disk content.
 * One-way migration (#4): legacy per-machine plan/unattended/yolo keys are stripped
 * on every save (they may still be present in old files).
 */
export function updateGuardState(mutate: (s: GuardState) => void): GuardState {
	const s = loadGuardState();
	mutate(s);
	fs.mkdirSync(path.dirname(GUARD_STATE_FILE), { recursive: true });
	// Strip legacy keys that pre-#4 versions may have left behind.
	const { planMode: _pm, planFile: _pf, planSessionId: _ps, unattendedMode: _um, unattendedSessionId: _us, yoloMode: _yo, ...clean } = s as GuardState & Record<string, unknown>;
	atomicWriteJson(GUARD_STATE_FILE, clean);
	return s;
}
