/**
 * Shared agent-state IO (schema owner for both files).
 *
 * Two state files, one rule: every save is a read-modify-write against FRESH disk
 * content (update*), and every write is atomic (tmp + rename) so a reader never
 * sees a partial file.
 *
 *   • session-state/<sessionId>.json — per console/session: plan mode, unattended.
 *   • guard-state.json               — machine-global: sandbox/push guards + grants + yolo.
 *
 * Yolo (#14): a MACHINE-GLOBAL setting in guard-state.json — a /guards yolo toggle
 * sticks until explicitly changed, across sessions, restarts, /new and /resume. Its
 * default is dynamic (yoloDefaultOn()): ON when we detect a sandbox (HUMBLE_PI_YOLO=1,
 * SANDBOX_NAME set, or /run/sandbox present) — the container is already the isolation
 * boundary, so the path-sandbox guard would only add noise. An explicit value in the
 * file always wins over the default.
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
}

export const DEFAULT_SESSION_STATE: SessionState = { planMode: false, planFile: null, unattendedMode: false };

/**
 * Yolo default (#14): ON when we detect a sandbox — the container IS the isolation
 * boundary, so the path-sandbox guard is redundant. Detection covers:
 *   • HUMBLE_PI_YOLO=1 — baked in by tools/sbx-pi.sh at create time (`sbx create --env`)
 *   • SANDBOX_NAME     — set by docker-sandboxes in every sandbox (also old sandboxes
 *                        created before the env var existed)
 *   • /run/sandbox     — present in direct/clone-mode sandboxes
 */
export function yoloDefaultOn(): boolean {
	return process.env.HUMBLE_PI_YOLO === "1"
		|| Boolean(process.env.SANDBOX_NAME)
		|| fs.existsSync("/run/sandbox");
}

/** Defaults for a session with no state file yet. */
function freshSessionState(): SessionState {
	return { ...DEFAULT_SESSION_STATE };
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
		// #14 one-way migration: strip the legacy per-session yolo key (now global).
		const { yoloMode: _legacyYolo, ...clean } = s as SessionState & Record<string, unknown>;
		return { ...freshSessionState(), ...clean };
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
	// #14 one-way migration: never persist the legacy per-session yolo key again.
	const { yoloMode: _legacyYolo, ...clean } = s as SessionState & Record<string, unknown>;
	atomicWriteJson(sessionStateFile(sessionId), clean);
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
	/** Yolo mode (#14): machine-global; default is dynamic — see yoloDefaultOn(). */
	yoloMode: boolean;
}

export const DEFAULT_GUARD_STATE: GuardState = {
	sandboxEnabled: true,
	pushGuardEnabled: true,
	allowedPaths: [],
	readOnlyPaths: [],
	allowedBranches: [],
	selectionMode: true,
	yoloMode: false,
};

/**
 * #14 one-way migration: when guard-state.json has no explicit yoloMode key yet, seed
 * it from the most recently modified session-state file (the old per-console setting),
 * falling back to the sandbox default. Persisted on the next save; an explicit value
 * in the file always wins over both.
 */
function migrateLegacyYolo(raw: Record<string, unknown>): boolean {
	if (typeof raw.yoloMode === "boolean") return raw.yoloMode;
	let best: { mtimeMs: number; yolo: boolean } | null = null;
	try {
		for (const f of fs.readdirSync(SESSION_STATE_DIR)) {
			if (!f.endsWith(".json")) continue;
			const p = path.join(SESSION_STATE_DIR, f);
			try {
				const s = JSON.parse(fs.readFileSync(p, "utf8"));
				if (typeof s?.yoloMode !== "boolean") continue;
				const mtimeMs = fs.statSync(p).mtimeMs;
				if (!best || mtimeMs > best.mtimeMs) best = { mtimeMs, yolo: s.yoloMode };
			} catch { /* unreadable/corrupt — skip */ }
		}
	} catch { /* dir missing — nothing to migrate */ }
	return best?.yolo ?? yoloDefaultOn();
}

/** Fresh read of the global guard state — defaults when missing or corrupt. Never cached. */
export function loadGuardState(): GuardState {
	try {
		const raw = JSON.parse(fs.readFileSync(GUARD_STATE_FILE, "utf8")) as Record<string, unknown>;
		const s = { ...DEFAULT_GUARD_STATE, ...raw } as GuardState;
		if (!Array.isArray(s.readOnlyPaths)) s.readOnlyPaths = [];
		s.yoloMode = migrateLegacyYolo(raw);
		return s;
	} catch {
		// No file yet — still run the one-way migration (it falls back to the default).
		return { ...DEFAULT_GUARD_STATE, allowedPaths: [], readOnlyPaths: [], allowedBranches: [], yoloMode: migrateLegacyYolo({}) };
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
	// Strip legacy keys that pre-#4 versions may have left behind. (#14: yoloMode is a
	// FIRST-CLASS global field again — do NOT strip it here.)
	const { planMode: _pm, planFile: _pf, planSessionId: _ps, unattendedMode: _um, unattendedSessionId: _us, ...clean } = s as GuardState & Record<string, unknown>;
	atomicWriteJson(GUARD_STATE_FILE, clean);
	return s;
}
