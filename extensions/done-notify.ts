/**
 * done-notify — "the run is over" and, more usefully, "pi is stuck waiting for me and I am not
 * at this machine".
 *
 * Local tier (your terminal, no dependencies): OSC 9 → Windows Terminal raises a native toast;
 * BEL → tab + taskbar flash and (with bellNotification) a sound. Every terminal honours BEL, so
 * the fallback is not a fallback you have to hope works.
 *
 * Remote tier (your phone / dashboard / TTS / lights): one POST to Home Assistant's notify
 * service, which fans out to whatever you already have on it. Set:
 *   HUMBLE_PI_HA_URL     e.g. http://homeassistant.local:8123
 *   HUMBLE_PI_HA_TOKEN   a long-lived HA token (env var only — this repo is public)
 *   HUMBLE_PI_HA_SERVICE notify.mobile_app_<your_device>  (default: persistent_notification.create,
 *                        which is UI-only — /notify services lists the names that reach a device)
 *   HUMBLE_PI_NOTIFY_LONG_RUN_S  a run must last this long to buzz the phone (default 90)
 *   HUMBLE_PI_NOTIFY_IDLE_S      no typing for this long counts as "not there" (default 120, 0 = off)
 *   HUMBLE_PI_NOTIFY_WAIT_DELAY_S how long a dialog must go unanswered before it escalates (default 45)
 *   HUMBLE_PI_NOTIFY_MIN_RUN_S   skip the toast for trivially short runs (default 0 = every run)
 *   HUMBLE_PI_NOTIFY_LOCAL       osc9,bell  (either, or "none"-ish by picking one)
 *   HUMBLE_PI_NOTIFY_REMOTE      0 to disable the HA tier without touching the local one
 *
 * Policy (chosen 2026-10-30 and revised the same day after using it): local on every run end. Remote
 * only when pi genuinely needs you and you are not at the keyboard — a dialog that has gone unanswered
 * past the patience window while nobody has typed, or a run that outlived the duration threshold while
 * nobody has typed. A dialog you answer inside that window produces a toast and a bell and no phone
 * call; the first version pushed the instant any dialog opened, which meant a buzz for every 20-second
 * task while sitting right in front of the screen. Rules live as pure functions in
 * extensions/lib/notify.ts and are tested in tools/test-done-notify.ts.
 *
 * Focus caveat, stated plainly: pi enables terminal focus reporting (?1004h) but never exposes
 * "is this window focused?" to extensions, so presence is measured by the last human-typed
 * message in this session. It is a proxy, not a sensor.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	decideRunEnd,
	decideWaiting,
	DEFAULTS,
	doneText,
	freshState,
	fmtDuration,
	haPath,
	listHomeAssistantServices,
	localSequence,
	maskSecret,
	readConfig,
	remoteConfigured,
	sendHomeAssistant,
	shouldNotifyRunEnd,
	waitingText,
	waitingEscalationMs,
	withNotifyEnvFile,
	type EnvSource,
	type NotifyState,
	type RunOutcome,
} from "./lib/notify.ts";

const STATE: NotifyState = freshState();
/** /notify on|off wins over the env var until the process restarts. */
let overrideEnabled: boolean | null = null;
/** Where the last config came from, so /notify status can name the file it actually read. */
let lastSource: EnvSource | null = null;

function config() {
	const src = withNotifyEnvFile(process.env);
	lastSource = src;
	const cfg = readConfig(src.env);
	if (overrideEnabled !== null) cfg.enabled = overrideEnabled;
	return cfg;
}

/**
 * "not configured" is only useful if it says where it looked. This is the message that would have
 * saved an hour: env vars set in a PowerShell profile never reach a container that was created
 * earlier, and that reads like a broken extension rather than a frozen environment.
 */
function notConfigured(ctx: ExtensionContext): void {
	const tried = lastSource?.filesTried ?? [];
	report(ctx, [
		"remote: not configured — it needs HUMBLE_PI_HA_URL and HUMBLE_PI_HA_TOKEN.",
		"  set them as env vars, or put them in a file the extension reads itself:",
		...(tried.length ? tried.map((f) => `    ${f}`) : ["    (no path available: HOME/USERPROFILE unset)"]),
		"  HUMBLE_PI_HA_ENV_FILE overrides that path.",
		"  why: a container's environment is fixed at sbx create — variables you set afterwards, on the host, are not visible inside it.",
	].join("\n"), "warning");
}

function nowMs(): number {
	return Date.now();
}

/** Local tier: straight to the terminal. Nothing to do when stdout is not a terminal. */
function localPing(text: string): boolean {
	const cfg = config();
	if (!process.stdout.isTTY) return false;
	const seq = localSequence(cfg, text);
	if (!seq) return false;
	try {
		process.stdout.write(seq);
		STATE.localSent++;
		return true;
	} catch {
		return false;
	}
}

/** Remote tier: fire and forget — a notification must never stall or fail an agent run. */
function remotePing(message: string, title = "pi"): void {
	const cfg = config();
	if (!remoteConfigured(cfg)) return;
	void sendHomeAssistant(cfg, message, title).then((res) => {
		if (res.ok) STATE.remoteSent++;
		else {
			STATE.remoteFailed++;
			STATE.lastError = res.error ?? `HTTP ${res.status}`;
		}
	});
}

/**
 * A dialog is not a push. It becomes one only after it has gone unanswered long enough and nobody has
 * typed, so the extension schedules a single timer for that moment — waitingEscalationMs() does the
 * arithmetic — and re-arms or cancels it as things change. unref() because a pending escalation must
 * never be the reason pi refuses to exit.
 */
let waitTimer: NodeJS.Timeout | null = null;

function scheduleWaitPing(minDelayMs = 0): void {
	if (waitTimer) {
		clearTimeout(waitTimer);
		waitTimer = null;
	}
	const at = waitingEscalationMs(config(), STATE);
	if (at === null) return;
	const delay = Math.max(minDelayMs, at - nowMs());
	waitTimer = setTimeout(() => {
		waitTimer = null;
		// Re-decided at fire time, not at schedule time: the dialog may have been answered, dismissed,
		// or you may have come back to the keyboard in the meantime.
		const d = decideWaiting(config(), STATE, nowMs());
		if (d) {
			remotePing(d.message, "pi needs you");
			return;
		}
		// Not yet — but that must not mean never. A dialog whose timer fired one step early (a wall-clock
		// jump over a suspend, a threshold edited underneath it, a timer rounded down) would otherwise
		// drop the only ping it was ever going to send, silently and with nothing left pending. Re-arm for
		// what is left, with a 1s floor so a pathological "not yet, and no later than now" cannot spin.
		if (STATE.dialogOpen !== null) scheduleWaitPing(1000);
	}, delay).unref();
}

function cancelWaitPing(): void {
	if (waitTimer) {
		clearTimeout(waitTimer);
		waitTimer = null;
	}
}

/** What /notify status says about a dialog that is open but not yet worth a phone. */
function escalationHint(): string {
	const at = waitingEscalationMs(config(), STATE);
	if (at === null) return " (no remote target)";
	const s = Math.max(0, Math.round((at - nowMs()) / 1000));
	return s <= 0 ? " (push armed now)" : ` (push at +${s}s unless you answer or type first)`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const keep = STATE.lastActivityMs;
		Object.assign(STATE, freshState(nowMs()));
		STATE.lastActivityMs = keep;
		cancelWaitPing();
	});

	pi.on("agent_start", () => {
		STATE.runStartedMs = nowMs();
		STATE.outcome = "completed";
	});

	// BoundaryState.outcome is the only place pi distinguishes completed / aborted / error.
	pi.on("agent_before_settle", (e) => {
		STATE.outcome = (e.outcome as RunOutcome) ?? STATE.outcome;
	});

	pi.on("agent_settled", (e) => {
		const started = STATE.runStartedMs;
		STATE.runStartedMs = null;
		const durationMs = started === null ? 0 : nowMs() - started;
		if (e.aborted) STATE.outcome = "aborted";
		if (!shouldNotifyRunEnd(config(), durationMs)) return;
		localPing(doneText(STATE.outcome, durationMs));
		const remote = decideRunEnd(config(), STATE, durationMs, nowMs());
		if (remote) remotePing(remote.message);
	});

	// pi blocks on a UI prompt: guards' /approve and permission dialogs, finish_plan's
	// Approve/Keep-planning, ask_user's selector, /backlog pickers when they use ctx.ui.
	pi.on("ui_prompt_start", (e) => {
		STATE.dialogOpen = e.title ?? e.kind;
		STATE.dialogOpenedMs = nowMs();
		localPing(waitingText(STATE.dialogOpen));
		scheduleWaitPing();
	});

	pi.on("ui_prompt_end", () => {
		STATE.dialogOpen = null;
		STATE.dialogOpenedMs = null;
		// Answered, dismissed or cancelled is a private event: a push that lands after you already
		// replied is worse than no push at all.
		cancelWaitPing();
		// A dialog only ends because something at this terminal closed it, and pi does not report those
		// keystrokes through `input` — they go to the selector, not the prompt line. Without this, answering
		// a question and sitting there for another 90 seconds ends the run as "long run + nobody around" and
		// phones you while you are looking at the screen. Unattended mode is unaffected: its auto-reject path
		// never opens a dialog, so no prompt_end fires and absence still counts as absence.
		STATE.lastActivityMs = nowMs();
	});

	// Presence proxy: a human-typed message means somebody is at this keyboard. Messages an
	// extension injects (guards' approve instruction, backlog actions) do not count.
	pi.on("input", (e) => {
		if (e.source === "extension") return;
		STATE.lastActivityMs = nowMs();
		// Re-armed rather than cancelled: typing proves you are here now, and if you then walk away the
		// dialog should still escalate — measured from this keystroke, not from when it opened.
		if (STATE.dialogOpen !== null) scheduleWaitPing();
	});

	pi.registerCommand("notify", {
		description:
			"Done/waiting notifications: /notify status | services | on | off | test [message]. Local = OSC 9 toast + BEL " +
			"(Windows Terminal). Remote = Home Assistant push.",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			const head = a.split(/\s+/)[0].toLowerCase();
			const rest = a.slice(head.length).trim();

			if (head === "on" || head === "off") {
				overrideEnabled = head === "on";
				if (!overrideEnabled) cancelWaitPing(); // silencing must also pull the plug on a pending escalation
				report(ctx, `/notify ${head} — ${overrideEnabled ? "notifications on" : "notifications silenced until pi restarts"}`);
				if (overrideEnabled) localPing("pi notifications on");
				return;
			}

			if (head === "services") {
				const cfg = config();
				if (!remoteConfigured(cfg)) {
					report(ctx, "remote: not configured — set HUMBLE_PI_HA_URL and HUMBLE_PI_HA_TOKEN first");
					return;
				}
				const probe = await listHomeAssistantServices(cfg);
				if (!probe.ok) {
					report(ctx, `HA refused the service list: ${probe.error}`, "error");
					return;
				}
				if (!probe.services.length) {
					report(ctx, "HA answered, but nothing on this instance can receive a message yet — no notify.* services", "warning");
					return;
				}
				report(ctx, [
					`HA accepts ${probe.services.length} service(s) for a pi message:`,
					...probe.services.map((s) => `  ${s}  →  POST ${haPath(s)}`),
					`  HUMBLE_PI_HA_SERVICE wants one of these names. Listed most-useful first:`,
					`  notify.mobile_app_* reach a device; persistent_notification.create is UI-only but always exists;`,
					`  notify.notify / notify.send_message are HA's generic entries and want a "target" (send one via HUMBLE_PI_HA_EXTRA).`,
				].join("\n"));
				return;
			}

			if (head === "test") {
				const cfg = config();
				const text = rest || "pi notification test";
				const localOk = localPing(text);
				report(ctx, `local: ${localOk ? `sent (${cfg.local.join(" + ")})` : "nothing written (stdout is not a terminal, or channels disabled)"}`);
				if (!remoteConfigured(cfg)) {
					notConfigured(ctx);
					return;
				}
				const res = await sendHomeAssistant(cfg, text, "pi test");
				if (res.ok) {
					STATE.remoteSent++;
					report(ctx, `remote: HA accepted it (HTTP ${res.status}) via ${cfg.haService}`);
				} else {
					STATE.remoteFailed++;
					STATE.lastError = res.error ?? `HTTP ${res.status}`;
					report(ctx, `remote failed: ${STATE.lastError}`, "error");
				}
				return;
			}

			const cfg = config();
			const runFor = STATE.runStartedMs === null ? null : nowMs() - STATE.runStartedMs;
			report(ctx, [
				`notifications ${cfg.enabled ? "ON" : "OFF"}`,
				`  local : ${cfg.local.length ? cfg.local.join(" + ") : "disabled"} (toast via OSC 9, then BEL)`,
				`          sent ${STATE.localSent}; runs shorter than ${cfg.minRunMs / 1000}s are skipped`,
				`  remote: ${remoteConfigured(cfg) ? "enabled" : "disabled"}`,
				`          ${cfg.haUrl || "HUMBLE_PI_HA_URL unset"}  service ${cfg.haService}  token ${maskSecret(cfg.haToken)}`,
				`          config source: ${lastSource?.fileUsed
						? `file ${lastSource.fileUsed}${lastSource.fromFile.length ? ` supplied ${lastSource.fromFile.join(", ")}` : ""}`
						: "environment only (no file read)"}`,
				...(cfg.haService === DEFAULTS.haService
					? [`          that target is UI-only (HA's own tray, no push) — /notify services lists a notify.mobile_app_* that reaches a phone`]
					: []),
				`          buzz rules: dialog unanswered ${cfg.waitDelayMs / 1000}s + no typing ${cfg.idleMs / 1000}s; or run ≥ ${cfg.longRunMs / 1000}s and idle ≥ ${cfg.idleMs / 1000}s`,
				`          sent ${STATE.remoteSent}, failed ${STATE.remoteFailed}${STATE.lastError ? ` (last: ${STATE.lastError})` : ""}`,
				`  now   : ${runFor === null ? "idle" : `run going ${fmtDuration(runFor)}`}, idle ${fmtDuration(nowMs() - STATE.lastActivityMs)}${STATE.dialogOpen ? `, blocked on "${STATE.dialogOpen}"${escalationHint()}` : ""}`,
				...(haPath(cfg.haService) ? [] : [`  HUMBLE_PI_HA_SERVICE "${cfg.haService}" is not "domain.service"`]),
				...(STATE.lastError ? [`  last failure — /notify services lists what this HA actually accepts`] : []),
			].join("\n"));
		},
	});
}

function report(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify?.(message, type);
	} catch {
		/* non-interactive mode */
	}
}

// Kept out of the extension graph on purpose: everything above is thin glue over the pure
// rules in lib/notify.ts, which is where the policy actually lives (and is tested).
