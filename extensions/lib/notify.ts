/**
 * notify — the mechanism behind extensions/done-notify.ts: "tell me it's finished" and, more
 * importantly, "tell me pi needs me and I'm not at the keyboard".
 *
 * Deliberately has NO pi imports: every rule that decides *whether* to ping is a pure function,
 * so tools/test-done-notify.ts can prove the policy without a running agent, and the escape
 * sequences / HTTP payload are built by functions a test can assert on.
 *
 * Two tiers:
 *   local  — written straight to the terminal: OSC 9 (Windows Terminal turns it into a native
 *            toast) and BEL (the fallback every terminal honours; Windows Terminal flashes the
 *            tab + taskbar and, with bellNotification enabled, plays a sound).
 *   remote — one POST to Home Assistant's REST notify service, which fans out to whatever you
 *            already have wired up (phone app, dashboard, TTS, lights). No shell-out, no agent.
 *
 * Presence heuristic: pi keeps terminal-window focus to itself (it enables ?1004h but never
 * tells extensions), so "are they there?" is measured the honest way — the last time the human
 * typed into this session. If nobody typed for idleMs, a long run may ping your phone.
 */

import fs from "node:fs";
import path from "node:path";

export type LocalChannel = "osc9" | "bell";
export type RunOutcome = "completed" | "aborted" | "error";

export interface NotifyConfig {
	/** Master switch (/notify off, or HUMBLE_PI_NOTIFY=0). */
	enabled: boolean;
	/** Which local channels to emit, in order. */
	local: LocalChannel[];
	/** Remote tier on/off. Off also when HA is not configured. */
	remoteEnabled: boolean;
	haUrl: string;
	/** HA service as "domain.service", e.g. notify.mobile_app_tobias or notify.notify */
	haService: string;
	haToken: string;
	/** Extra JSON merged into the notify payload (data, target, …). Empty when unset/invalid. */
	haExtra: Record<string, unknown>;
	/** A run at least this long counts as "worth a phone buzz" (0 = never pings for duration). */
	longRunMs: number;
	/** No human input for this long counts as "not there" (0 = heuristic disabled). */
	idleMs: number;
	/** Local notifications are skipped for runs shorter than this (0 = every run end). */
	minRunMs: number;
	timeoutMs: number;
}

export interface NotifyState {
	/** When the current agent run began, or null when idle. */
	runStartedMs: number | null;
	outcome: RunOutcome;
	/** Last time the human typed something into this session (extension-injected excluded). */
	lastActivityMs: number;
	/** Title of the UI prompt pi is currently blocked on, or null. */
	dialogOpen: string | null;
	/** Counters for /notify status. */
	localSent: number;
	remoteSent: number;
	remoteFailed: number;
	lastError: string | null;
}

export const DEFAULTS = {
	longRunS: 90,
	idleS: 30,
	minRunS: 0,
	timeoutMs: 4000,
	// Not "notify.notify". HA documents that one as shorthand for "the first notify thing I can
	// find", it is integration-specific, and on current versions it can fail outright
	// (home-assistant/core#111015). A default that surprises nobody beats one that reaches a phone
	// by luck: this always exists, always accepts {title, message}, and lands in HA's own tray.
	// Set HUMBLE_PI_HA_SERVICE to a notify.mobile_app_* (see /notify services) to reach a device.
	haService: "persistent_notification.create",
};

/** Environment is read per call so `/notify status` always reports live values. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
	const num = (v: string | undefined, fallback: number): number => {
		const n = Number(v);
		return Number.isFinite(n) && n >= 0 ? n : fallback;
	};
	const local: LocalChannel[] = [];
	const raw = (env.HUMBLE_PI_NOTIFY_LOCAL ?? "osc9,bell").toLowerCase();
	for (const part of raw.split(/[,\s]+/)) {
		if (part === "osc9" || part === "bell") local.push(part);
	}
	const off = env.HUMBLE_PI_NOTIFY === "0" || env.HUMBLE_PI_NOTIFY === "off";
	return {
		enabled: !off,
		local: local.length > 0 ? local : ["osc9", "bell"],
		remoteEnabled: !(env.HUMBLE_PI_NOTIFY_REMOTE === "0" || env.HUMBLE_PI_NOTIFY_REMOTE === "off"),
		haUrl: (env.HUMBLE_PI_HA_URL ?? "").trim().replace(/\/+$/, ""),
		haService: (env.HUMBLE_PI_HA_SERVICE ?? DEFAULTS.haService).trim(),
		haToken: (env.HUMBLE_PI_HA_TOKEN ?? "").trim(),
		haExtra: parseExtra(env.HUMBLE_PI_HA_EXTRA),
		longRunMs: num(env.HUMBLE_PI_NOTIFY_LONG_RUN_S, DEFAULTS.longRunS) * 1000,
		idleMs: num(env.HUMBLE_PI_NOTIFY_IDLE_S, DEFAULTS.idleS) * 1000,
		minRunMs: num(env.HUMBLE_PI_NOTIFY_MIN_RUN_S, DEFAULTS.minRunS) * 1000,
		timeoutMs: num(env.HUMBLE_PI_NOTIFY_TIMEOUT_MS, DEFAULTS.timeoutMs),
	};
}

function parseExtra(raw: string | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function freshState(nowMs = Date.now()): NotifyState {
	return {
		runStartedMs: null,
		outcome: "completed",
		lastActivityMs: nowMs,
		dialogOpen: null,
		localSent: 0,
		remoteSent: 0,
		remoteFailed: 0,
		lastError: null,
	};
}

/** Is the remote tier actually usable (switch on + HA url/token/service present)? */
export function remoteConfigured(cfg: NotifyConfig): boolean {
	return cfg.enabled && cfg.remoteEnabled && cfg.haUrl !== "" && cfg.haToken !== "" && cfg.haService !== "";
}

/**
 * Env vars alone cannot reach a sandbox. A container's environment is fixed at `sbx create`, so
 * variables you set in your PowerShell profile afterwards — or on a machine you did not create the
 * sandbox from — are simply not there, and "remote: not configured" looks like a bug in the
 * extension. So config may also come from a file the extension reads itself, which means it works
 * for sandboxes that already exist and for any tool that cannot be handed an env var.
 *
 * Default location is pi's own config dir ($HOME/.pi/agent/notify.env): outside any repo, never
 * committed, and the same path inside the container.
 */
export const NOTIFY_ENV_REL = [".pi", "agent", "notify.env"];

export type FileReader = (p: string) => string | null;

const readText: FileReader = (p) => {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return null;
	}
};

/** KEY=value lines, # comments, optional `export ` prefix, optional quotes. Only our own keys. */
export function parseNotifyEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = /^(?:export\s+)?(HUMBLE_PI_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		out[m[1]] = v;
	}
	return out;
}

export function notifyEnvFileCandidates(env: NodeJS.ProcessEnv): string[] {
	const explicit = (env.HUMBLE_PI_HA_ENV_FILE ?? "").trim();
	if (explicit) return [explicit];
	const home = env.HOME || env.USERPROFILE || "";
	if (!home) return [];
	return [path.join(home, ...NOTIFY_ENV_REL)];
}

export interface EnvSource {
	env: NodeJS.ProcessEnv;
	/** The file that contributed values, or null if nothing was read. */
	fileUsed: string | null;
	filesTried: string[];
	/** Keys that came from the file rather than the real environment. */
	fromFile: string[];
}

export function withNotifyEnvFile(env: NodeJS.ProcessEnv = process.env, readFile: FileReader = readText): EnvSource {
	const filesTried = notifyEnvFileCandidates(env);
	// An empty string is "deliberately unset" in some shells, not "absent" — it must not beat the file.
	const real: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (v !== "" && v !== undefined) real[k] = v;
	for (const f of filesTried) {
		const text = readFile(f);
		if (text === null) continue;
		const fromFile = parseNotifyEnvFile(text);
		if (!Object.keys(fromFile).length) continue;
		// The real environment wins: a one-off `HUMBLE_PI_HA_SERVICE=… pi` must beat the file, and a
		// file must never quietly override something you set on purpose.
		const contributed = Object.keys(fromFile).filter((k) => real[k] === undefined);
		return { env: { ...fromFile, ...real }, fileUsed: f, filesTried, fromFile: contributed };
	}
	return { env: real, fileUsed: null, filesTried, fromFile: [] };
}

export interface RemoteDecision {
	reason: "waiting" | "long_run";
	/** What the phone should say. */
	message: string;
}

/**
 * A dialog is open → pi is genuinely blocked on a human. Always worth a remote ping, even if
 * someone is sitting right there: an un-answered approval is the one state where doing nothing
 * costs the most. (Policy choice, 2026-10-30.)
 */
export function decideWaiting(cfg: NotifyConfig, state: NotifyState): RemoteDecision | null {
	if (!remoteConfigured(cfg) || !state.dialogOpen) return null;
	return { reason: "waiting", message: waitingText(state.dialogOpen) };
}

/**
 * Run finished → ping only when it took long enough AND nobody has typed for a while. Without
 * the idle check you would get a phone buzz for work you are watching happen on screen.
 */
export function decideRunEnd(
	cfg: NotifyConfig,
	state: NotifyState,
	durationMs: number,
	nowMs = Date.now(),
): RemoteDecision | null {
	if (!remoteConfigured(cfg)) return null;
	if (cfg.longRunMs <= 0 || durationMs < cfg.longRunMs) return null;
	const idleMs = nowMs - state.lastActivityMs;
	if (cfg.idleMs > 0 && idleMs < cfg.idleMs) return null; // somebody is here
	return { reason: "long_run", message: doneText(state.outcome, durationMs) };
}

/** Should this run end produce a local toast/bell at all? */
export function shouldNotifyRunEnd(cfg: NotifyConfig, durationMs: number): boolean {
	return cfg.enabled && cfg.local.length > 0 && durationMs >= cfg.minRunMs;
}

// ── text + wire formats ────────────────────────────────────────────────────

/**
 * Terminal-safety filter. A notification title comes from pi (dialog titles, task text), which
 * can contain anything a model wrote. BEL would terminate our OSC 9 half-way and ESC could start
 * a sequence we never intended to send, so whole sequences are removed — not just the ESC byte,
 * which would leave the parameters behind as visible junk ("red \x1b[31mtext" → "red [31mtext").
 * Removed sequences become a space so neighbouring words cannot glue into a new word.
 */
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const DCS_RE = /\x1b[PX^_][^\x1b]*\x1b\\?/g;
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

export function sanitize(text: string, maxLen = 200): string {
	const cleaned = text
		.replace(OSC_RE, " ")
		.replace(DCS_RE, " ")
		.replace(CSI_RE, " ")
		.replace(CONTROL_RE, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLen) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function fmtDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	if (mins < 60) return secs ? `${mins}m ${String(secs).padStart(2, "0")}s` : `${mins}m`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
}

export function doneText(outcome: RunOutcome, durationMs: string | number): string {
	const dur = typeof durationMs === "number" ? fmtDuration(durationMs) : durationMs;
	if (outcome === "aborted") return `pi stopped — ${dur}`;
	if (outcome === "error") return `pi hit an error — ${dur}`;
	return `pi finished — ${dur}`;
}

export function waitingText(title: string): string {
	const t = sanitize(title, 120);
	return t ? `pi needs you — ${t}` : "pi needs you — waiting for an answer";
}

/** OSC 9 as Windows Terminal reads it (body text only), terminated by BEL. */
export function osc9(text: string): string {
	return `\x1b]9;${sanitize(text)}\x07`;
}

export const BEL = "\x07";

/** The exact bytes to write for one local notification ("" when nothing to write). */
export function localSequence(cfg: NotifyConfig, text: string): string {
	let out = "";
	for (const channel of cfg.local) {
		if (channel === "osc9") out += osc9(text);
		else out += BEL;
	}
	return out;
}

/**
 * HA REST path for a service named "domain.service":
 *   notify.mobile_app_tobias → /api/services/notify/mobile_app_tobias
 * Verified against a live Home Assistant rather than assumed: that route answers 401 without a
 * token, while a trailing "/notify" (the obvious-looking guess) answers 404. Anything under
 * /api/services/<domain>/<service> reaches HA's service-call handler.
 */
export function haPath(service: string): string | null {
	const m = /^([a-z_]+)\.([a-z0-9_]+)$/.exec(service.trim());
	if (!m) return null;
	return `/api/services/${m[1]}/${m[2]}`;
}

/** JSON body for HA's notify service call. */
export function haBody(cfg: NotifyConfig, message: string, title = "pi"): string {
	return JSON.stringify({ title, message, ...cfg.haExtra });
}

/** Token shown back to the user without ever printing the token. */
export function maskSecret(secret: string): string {
	if (!secret) return "(unset)";
	if (secret.length <= 6) return "••••";
	return `${secret.slice(0, 3)}…${secret.slice(-2)} (${secret.length} chars)`;
}

export interface RemoteResult {
	ok: boolean;
	status?: number;
	error?: string;
}

/**
 * The only side-effecting function here, with fetch injectable so tests never touch a network.
 * HA answers 200 with the list of services it notified.
 */
export async function sendHomeAssistant(
	cfg: NotifyConfig,
	message: string,
	title = "pi",
	fetchImpl: typeof fetch = fetch,
): Promise<RemoteResult> {
	const path = haPath(cfg.haService);
	if (!path) return { ok: false, error: `HUMBLE_PI_HA_SERVICE must look like "domain.service" (e.g. notify.mobile_app_phone), got "${cfg.haService}"` };
	if (!cfg.haUrl || !cfg.haToken) return { ok: false, error: "HUMBLE_PI_HA_URL / HUMBLE_PI_HA_TOKEN not set" };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(500, cfg.timeoutMs));
	try {
		const res = await fetchImpl(`${cfg.haUrl}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${cfg.haToken}`,
				"Content-Type": "application/json",
			},
			body: haBody(cfg, message, title),
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = (await res.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ").trim();
			return { ok: false, status: res.status, error: `HTTP ${res.status}${body ? ` — ${body}` : ""}` };
		}
		return { ok: true, status: res.status };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: /abort/i.test(msg) ? `timed out after ${cfg.timeoutMs}ms` : msg };
	} finally {
		clearTimeout(timer);
	}
}

export interface ServiceProbe extends RemoteResult {
	services: string[];
}

interface RawServiceEntry {
	domain?: string;
	service?: string;
	services?: Record<string, unknown>;
}

/**
 * HA has shipped two shapes for this listing and both are live in the field:
 *   older   [ { domain: "notify", service: "mobile_app_x", … }, … ]
 *   newer   [ { domain: "notify", services: { mobile_app_x: {…}, persistent_notification: {…} } } ]
 * The grouped form is what a current install answers with (proved against a real Pi, not assumed —
 * a flat-only parser reads that answer as "this instance has no notify services", which is a
 * confident wrong statement about a phone that is registered and waiting).
 */
export function flattenServices(raw: unknown): string[] {
	const out = new Set<string>();
	for (const item of Array.isArray(raw) ? raw : []) {
		if (!item || typeof item !== "object") continue;
		const e = item as RawServiceEntry;
		const domain = typeof e.domain === "string" ? e.domain : "";
		if (!domain) continue;
		if (typeof e.service === "string") out.add(`${domain}.${e.service}`);
		if (e.services && typeof e.services === "object") {
			for (const name of Object.keys(e.services)) out.add(`${domain}.${name}`);
		}
	}
	return [...out];
}

/**
 * Order matters here: "which of these do I put in the env var?" is the question the listing exists
 * to answer, so the entries that actually reach a device come first and HA's generic catch-alls —
 * which want a `target` — come last.
 */
function rank(name: string): number {
	if (/^notify\.mobile_app_/.test(name)) return 0;
	if (name === "persistent_notification.create") return 1;
	return 2;
}

export function messageCapableServices(raw: unknown): string[] {
	return flattenServices(raw)
		.filter((n) => /^notify\.[a-z0-9_]+$/.test(n) || n === "persistent_notification.create")
		.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Ask HA which services it actually answers to. Worth its own call because of how HA's REST API
 * fails: 401 = bad token, 404 = service that does not exist, **400 = the service exists but the
 * payload does not match its schema**. A 400 therefore tells you nothing about the name you should
 * have used — and guessing a mobile device id is a guessing game. This reads the truth.
 *
 * Returns notify.* plus persistent_notification.create, which every HA install has and which needs
 * exactly {title, message} — the best first target when the phone half is not wired up yet.
 */
export async function listHomeAssistantServices(
	cfg: NotifyConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<ServiceProbe> {
	if (!cfg.haUrl || !cfg.haToken) return { ok: false, error: "HUMBLE_PI_HA_URL / HUMBLE_PI_HA_TOKEN not set", services: [] };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(500, cfg.timeoutMs));
	try {
		const res = await fetchImpl(`${cfg.haUrl}/api/services`, {
			headers: { Authorization: `Bearer ${cfg.haToken}` },
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = (await res.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ").trim();
			return { ok: false, status: res.status, error: `HTTP ${res.status}${body ? ` — ${body}` : ""}`, services: [] };
		}
		const raw: unknown = await res.json();
		return { ok: true, status: res.status, services: messageCapableServices(raw) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: /abort/i.test(msg) ? `timed out after ${cfg.timeoutMs}ms` : msg, services: [] };
	} finally {
		clearTimeout(timer);
	}
}
