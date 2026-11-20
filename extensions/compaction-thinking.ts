/**
 * compaction-thinking — auto-compaction keeps failing when thinking is set high.
 *
 * It is not the compaction that is broken, it is the summary request's token budget.
 * Pi summarizes with the session's CURRENT thinking level
 * (`options.reasoning = thinkingLevel`, pi's dist/core/compaction/compaction.js) and
 * gives that request no budget of its own: its ceiling is
 * min(model.maxTokens, contextWindow − input − margin) from pi-ai's
 * clampMaxTokensToContext(). With `maxTokens: 16384` on every local model in
 * ~/.pi/agent/models.json, an uncapped reasoning phase consumes the whole ceiling and
 * the model answers with stopReason "length" and no summary text. Pi refuses to persist
 * a truncated summary — "Summarization failed: generation hit the token cap and the
 * summary is incomplete" — writes no CompactionEntry, and tries again next turn. At
 * thinking=high that is a failure you hit every few turns, each one costing a full
 * local generation.
 *
 * This extension keeps `high` where you want it — the actual work — and runs the
 * summarization call at `off`, then puts the level back. Pi's own compaction path
 * (split-turn merge, file tracking, retry policy, overflow recovery) is untouched;
 * only the thinking level under it changes.
 *
 * Ordering that makes it work: pi awaits `session_before_compact` BEFORE it resolves
 * the summarization request (`_runDefaultCompaction` → `_getSummarizationRequestAuth`
 * reads `this.thinkingLevel`), in both the manual `/compact` path and the automatic
 * threshold/overflow path. So a level set inside this hook is the level the summary runs
 * at. Restored on `session_compact` / `session_compact_failed` (the failed event fires
 * for failures and aborts alike), with an `agent_end` net in case a handler throws.
 *
 * Verified against humbel's own servers (2026-11-20) with the exact payload shapes pi
 * sends — see extensions/lib/compact-think.ts for the measurements:
 *   8888 unsloth studio  top-level enable_thinking honoured → `off` really disables it
 *   8890 llama.cpp arm   top-level enable_thinking IGNORED → needs the models.json
 *                        compat fix (chat_template_kwargs + thinking_budget_tokens),
 *                        otherwise thinking runs uncapped even at thinking=off
 *
 * Config:
 *   HUMBEL_PI_COMPACT_THINKING   off (default) | minimal | low | medium | high | xhigh |
 *                                max | keep ("keep" = leave the session level alone)
 *   /compact-think [level|keep|status]   set it for this session without restarting
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import {
	failureNotice,
	holdStatus,
	idleHold,
	isHolding,
	isLevel,
	LEVELS,
	LEVEL_ENV,
	planHold,
	planRelease,
	readConfig,
	reconcileHold,
	type Hold,
	type LevelName,
	type Target,
} from "./lib/compact-think.ts";

export default function (pi: ExtensionAPI) {
	const boot = readConfig(process.env);
	let target: Target = boot.target;
	let hold: Hold = idleHold;

	const warn = (ctx: ExtensionContext, message: string): void => {
		if (!ctx.hasUI) return;
		try { ctx.ui.notify(message, "warning"); } catch { /* non-interactive mode */ }
	};

	/** Put the level back, unless somebody else already moved it. */
	const release = (): void => {
		if (!isHolding(hold)) return;
		const plan = planRelease(hold, pi.getThinkingLevel() as LevelName);
		hold = idleHold;
		if (plan.level) pi.setThinkingLevel(plan.level);
	};

	// A new session must not inherit a level we forced in the previous one, and a bad
	// HUMBEL_PI_COMPACT_THINKING value has to be said out loud — silently ignored it
	// reads as "this fix does nothing".
	pi.on("session_start", (_e, ctx) => {
		hold = idleHold;
		if (boot.warning) warn(ctx, `${LEVEL_ENV}: ${boot.warning}`);
	});

	pi.on("session_before_compact", (_event: SessionBeforeCompactEvent, _ctx: ExtensionContext) => {
		const current = pi.getThinkingLevel() as LevelName;
		const planned = planHold(current, target);
		hold = planned.hold;
		if (!planned.changed) return;

		pi.setThinkingLevel(planned.hold.forced as LevelName);
		// pi clamps to what the model supports; hold the level we actually got so
		// release() can tell "my own change" from "the model/human moved it".
		const effective = pi.getThinkingLevel() as LevelName;
		hold = reconcileHold(planned.hold, effective);
	});

	pi.on("session_compact", () => release());

	pi.on("session_compact_failed", (event: SessionCompactFailedEvent, ctx: ExtensionContext) => {
		release();
		const notice = failureNotice(event);
		if (notice) {
			warn(ctx, `${notice} — the summary had no room for its answer. Summaries now run at "${target}" (${LEVEL_ENV}).`);
		}
	});

	// Net: if a compaction never reaches session_compact/_failed (another handler threw,
	// or the run was torn down mid-compaction), do not leave the level dropped.
	pi.on("agent_end", () => {
		if (isHolding(hold)) release();
	});

	pi.registerCommand("compact-think", {
		description:
			`Thinking level used for compaction summaries: /compact-think [${LEVELS.join("|")}|keep|status] ` +
			`(default off; env ${LEVEL_ENV} sets it at startup)`,
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "" || arg === "status") {
				if (ctx.hasUI) ctx.ui.notify(holdStatus(hold, target, pi.getThinkingLevel() as LevelName), "info");
				return;
			}
			const parsed = isLevel(arg) || arg === "keep" ? (arg as Target) : null;
			if (!parsed) {
				warn(ctx, `unknown level "${arg}" — use one of ${LEVELS.join(", ")} or keep`);
				return;
			}
			target = parsed;
			if (ctx.hasUI) ctx.ui.notify(holdStatus(hold, target, pi.getThinkingLevel() as LevelName), "info");
		},
	});
}
