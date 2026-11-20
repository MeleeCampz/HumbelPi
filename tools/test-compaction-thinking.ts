/**
 * Regression test for compaction-thinking (extensions/compaction-thinking.ts +
 * extensions/lib/compact-think.ts).
 *
 * What is under test is the level bookkeeping, because that is where the damage hides.
 * The extension raises the thinking level of a summarization call and MUST put it back:
 * get it wrong one way and compaction still runs at `high` (the failure you started
 * fixing); get it wrong the other way and a level you set by hand — or the one pi picks
 * when you switch models — gets stomped back to whatever the summary used. Both mistakes
 * look like "thinking is acting strange", neither looks like a crash.
 *
 * The wiring is driven through a fake pi (on/getThinkingLevel/setThinkingLevel/
 * registerCommand) that mirrors pi's real ordering: pi awaits session_before_compact
 * BEFORE it resolves the summarization request's thinking level, and fires
 * session_compact or session_compact_failed afterwards — the failed event covers
 * failures AND aborts.
 *
 * Also covered: pi clamps a level to what the model supports, so the level asked for is
 * not the level held (reconcileHold) — a test for that is a test against a restore that
 * silently never happens.
 *
 * Run: npx tsx tools/test-compaction-thinking.ts        Exit 0 = all pass. No terminal, no pi runtime.
 */
import compactionThinking from "../extensions/compaction-thinking.ts";
import {
	DEFAULT_TARGET,
	failureNotice,
	holdStatus,
	idleHold,
	isHolding,
	isLevel,
	LEVELS,
	LEVEL_ENV,
	llamaCppCompat,
	planHold,
	planRelease,
	readConfig,
	reconcileHold,
	type Hold,
	type LevelName,
	type Target,
} from "../extensions/lib/compact-think.ts";

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures++;
	console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
}

// ---------------------------------------------------------------- pure: config
console.log("parseTarget / readConfig");
check("unset → default off", readConfig({}), { target: DEFAULT_TARGET });
check("empty string → default", readConfig({ [LEVEL_ENV]: "  " }), { target: "off" });
check("medium", readConfig({ [LEVEL_ENV]: "medium" }), { target: "medium" });
check("alias med → medium", readConfig({ [LEVEL_ENV]: "med" }), { target: "medium" });
check("alias none → off", readConfig({ [LEVEL_ENV]: "none" }), { target: "off" });
check("keep is honoured", readConfig({ [LEVEL_ENV]: "keep" }), { target: "keep" });
check("case-insensitive", readConfig({ [LEVEL_ENV]: "HIGH" }), { target: "high" });
const bad = readConfig({ [LEVEL_ENV]: "maximum" });
check("unknown falls back", bad.target, DEFAULT_TARGET);
check("unknown warns", typeof bad.warning === "string" && bad.warning.includes("maximum"), true);
check("every level name is accepted", LEVELS.every((l) => isLevel(l)), true);

// ---------------------------------------------------------------- pure: hold/release
console.log("planHold / reconcileHold / planRelease");
check("keep → no hold", planHold("high", "keep"), { hold: idleHold, changed: false });
check("already there → no hold", planHold("off", "off"), { hold: idleHold, changed: false });
check("high → off holds high", planHold("high", "off"), { hold: { saved: "high", forced: "off" }, changed: true });
check("off → high holds off", planHold("off", "high"), { hold: { saved: "off", forced: "high" }, changed: true });
check("not holding → nothing to release", planRelease(idleHold, "high"), { level: null, skipped: "not-held" });
check("release puts the saved level back", planRelease({ saved: "high", forced: "off" }, "off"), { level: "high" });
check("level moved during compaction → hands off", planRelease({ saved: "high", forced: "off" }, "low"), { level: null, skipped: "changed-elsewhere" });

// pi clamps: asked for "off" on a model that refuses it, we get e.g. "minimal" back.
const clamped = reconcileHold({ saved: "high", forced: "off" }, "minimal");
check("clamp keeps the effective level", clamped, { saved: "high", forced: "minimal" });
check("clamped level is what release compares against", planRelease(clamped, "minimal").level, "high");
check("reconcile of a non-hold stays a non-hold", reconcileHold(idleHold, "minimal"), idleHold);
check("isHolding", [isHolding(idleHold), isHolding(clamped)], [false, true]);

console.log("notices");
check(
	"threshold failure names the mechanism",
	failureNotice({ reason: "threshold", aborted: false, errorMessage: "Compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete", fromExtension: false }),
	'auto-compaction failed: Compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete',
);
check("overflow failure names recovery", failureNotice({ reason: "overflow", aborted: false, errorMessage: "boom", fromExtension: true }), "overflow recovery failed (extension summary): boom");
check("/compact failure", failureNotice({ reason: "manual", aborted: false, errorMessage: "Already compacted", fromExtension: false }), "/compact failed: Already compacted");
check("an abort says nothing", failureNotice({ reason: "threshold", aborted: true, fromExtension: false }), null);
check("status line", holdStatus({ saved: "high", forced: "off" }, "off", "off"), 'compaction thinking: summarize at "off" — mid-compaction, "off" in place, will restore "high" (session level now "off")');
check("status line, not holding", holdStatus(idleHold, "keep", "high"), 'compaction thinking: kept as-is (session level now "high")');

// The llama.cpp arm ignores pi's top-level enable_thinking; these are the fields that
// measured as honoured on port 8890 (see lib/compact-think.ts for the probe log).
check("llama.cpp compat shape", llamaCppCompat, {
	thinkingFormat: "chat-template",
	chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
	thinkingTokenBudgetField: "thinking_budget_tokens",
});

// ---------------------------------------------------------------- wiring harness
interface FakePi {
	handlers: Map<string, Array<(e: any, ctx: any) => void>>;
	commands: Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>;
	level: LevelName;
	/** Levels a model accepts — used to reproduce pi's clamping. */
	allowed: LevelName[];
	setCalls: LevelName[];
	on(type: string, fn: (e: any, ctx: any) => void): void;
	getThinkingLevel(): LevelName;
	setThinkingLevel(level: LevelName): void;
	registerCommand(name: string, def: { description: string; handler: (args: string, ctx: any) => Promise<void> }): void;
	emit(type: string, event: any): void;
}

function fakePi(start: LevelName, allowed: LevelName[] = [...LEVELS]): FakePi {
	return {
		handlers: new Map(),
		commands: new Map(),
		level: start,
		allowed,
		setCalls: [],
		on(type, fn) {
			const list = this.handlers.get(type) ?? [];
			list.push(fn);
			this.handlers.set(type, list);
		},
		getThinkingLevel() {
			return this.level;
		},
		setThinkingLevel(level) {
			// pi clamps a level the model does not offer.
			this.level = this.allowed.includes(level) ? level : "minimal";
			this.setCalls.push(this.level);
		},
		registerCommand(name, def) {
			this.commands.set(name, def);
		},
		emit(type, event) {
			for (const fn of this.handlers.get(type) ?? []) fn(event, ctxOf(this));
		},
	};
}

const notices: Array<{ text: string; level: string }> = [];
function ctxOf(_pi: FakePi) {
	return {
		hasUI: true,
		ui: {
			notify: (text: string, level: string) => {
				notices.push({ text, level });
			},
		},
	};
}

function run(pi: FakePi): void {
	compactionThinking(pi as never);
}

const EV_BEFORE = { type: "session_before_compact", preparation: {}, branchEntries: [], reason: "threshold", willRetry: false, signal: new AbortController().signal };
const EV_COMPACT = { type: "session_compact", compactionEntry: { id: "c1" }, fromExtension: false, reason: "threshold", willRetry: false };

console.log("wiring: high session, default target off");
{
	notices.length = 0;
	const pi = fakePi("high");
	run(pi);

	pi.emit("session_before_compact", EV_BEFORE);
	check("summary request sees off", pi.level, "off");

	pi.emit("session_compact", EV_COMPACT);
	check("level restored after success", pi.level, "high");
	check("two level writes only", pi.setCalls, ["off", "high"]);
	check("no noise on the happy path", notices.length, 0);
}

console.log("wiring: the summary fails (the bug being fixed)");
{
	notices.length = 0;
	const pi = fakePi("high");
	run(pi);

	pi.emit("session_before_compact", EV_BEFORE);
	pi.emit("session_compact_failed", {
		type: "session_compact_failed",
		reason: "threshold",
		aborted: false,
		errorMessage: "Compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete",
		fromExtension: false,
	});
	check("a failed compaction still restores the level", pi.level, "high");
	check("and says why once", notices.length, 1);
	check("notice names the token cap", notices[0].text.includes("hit the token cap"), true);
	check("notice names the new summary level", notices[0].text.includes('"off"'), true);
	check("notice is a warning", notices[0].level, "warning");
}

console.log("wiring: aborted compaction (Esc)");
{
	notices.length = 0;
	const pi = fakePi("high");
	run(pi);
	pi.emit("session_before_compact", EV_BEFORE);
	pi.emit("session_compact_failed", { type: "session_compact_failed", reason: "manual", aborted: true, fromExtension: false });
	check("abort restores", pi.level, "high");
	check("abort is silent", notices.length, 0);
}

console.log("wiring: a compaction that never settles");
{
	const pi = fakePi("high");
	run(pi);
	pi.emit("session_before_compact", EV_BEFORE);
	check("dropped level while running", pi.level, "off");
	pi.emit("agent_end", { type: "agent_end", messages: [] });
	check("agent_end net puts it back", pi.level, "high");
}

console.log("wiring: you moved the level while the summary ran");
{
	const pi = fakePi("high");
	run(pi);
	pi.emit("session_before_compact", EV_BEFORE);
	pi.setThinkingLevel("low"); // your keypress, or a model switch re-picking per model
	pi.emit("session_compact", EV_COMPACT);
	check("the human's level wins", pi.level, "low");
	check("no write-back at all", pi.setCalls, ["off", "low"]);
}

console.log("wiring: the model refuses off (pi clamps)");
{
	const pi = fakePi("high", ["minimal", "low", "medium", "high"]);
	run(pi);
	pi.emit("session_before_compact", EV_BEFORE);
	check("clamped to what the model offers", pi.level, "minimal");
	pi.emit("session_compact", EV_COMPACT);
	check("clamped hold still knows how to go back", pi.level, "high");
}

console.log("wiring: already at the target → no transcript churn");
{
	const pi = fakePi("off");
	run(pi);
	pi.emit("session_before_compact", EV_BEFORE);
	pi.emit("session_compact", EV_COMPACT);
	check("zero level writes", pi.setCalls, []);
}

console.log("wiring: keep (extension disabled)");
{
	process.env[LEVEL_ENV] = "keep";
	const pi = fakePi("high");
	run(pi);
	pi.emit("session_before_compact", EV_BEFORE);
	pi.emit("session_compact", EV_COMPACT);
	check("untouched", [pi.level, pi.setCalls], ["high", []]);
	delete process.env[LEVEL_ENV];
}

console.log("wiring: repeated compactions in one run");
{
	const pi = fakePi("high");
	run(pi);
	for (let i = 0; i < 3; i++) {
		pi.emit("session_before_compact", { ...EV_BEFORE, reason: i === 2 ? "overflow" : "threshold" });
		pi.emit("session_compact", { ...EV_COMPACT, reason: i === 2 ? "overflow" : "threshold" });
	}
	check("each one in and out", pi.setCalls, ["off", "high", "off", "high", "off", "high"]);
	check("ends where it started", pi.level, "high");
}

console.log("wiring: session switch drops a stale hold");
{
	const pi = fakePi("high");
	run(pi);
	pi.emit("session_before_compact", EV_BEFORE);
	check("dropped for the summary", pi.level, "off");
	pi.emit("session_start", { type: "session_start", sessionPath: "/tmp/other.jsonl", cwd: "/tmp", timestamp: "now" });
	pi.emit("session_compact", EV_COMPACT);
	check("a hold from the previous session is not written into the new one", [pi.level, pi.setCalls], ["off", ["off"]]);
}

console.log("wiring: /compact-think");
{
	process.env[LEVEL_ENV] = "low";
	const pi = fakePi("high");
	run(pi);
	const cmd = pi.commands.get("compact-think");
	check("command registered", cmd !== undefined, true);
	notices.length = 0;
	void cmd!.handler("", ctxOf(pi));
	check("status reports the env target", notices[0].text.includes('summarize at "low"'), true);
	notices.length = 0;
	void cmd!.handler("keep", ctxOf(pi));
	pi.emit("session_before_compact", EV_BEFORE);
	pi.emit("session_compact", EV_COMPACT);
	check("keep takes effect immediately", [pi.level, pi.setCalls], ["high", []]);
	notices.length = 0;
	void cmd!.handler("nonsense", ctxOf(pi));
	check("bad level warns", notices.length, 1);
	check("bad level leaves the setting alone", notices[0].text.includes("nonsense"), true);
	delete process.env[LEVEL_ENV];
}

// ---------------------------------------------------------------- target sanity
const targets: Target[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "keep"];
check("target names cover every level plus keep", targets.filter((t) => t !== "keep" && !isLevel(t as LevelName)), []);

console.log(failures === 0 ? `ALL PASS (${checks} checks)` : `\n${failures} of ${checks} FAILED`);
process.exit(failures === 0 ? 0 : 1);
