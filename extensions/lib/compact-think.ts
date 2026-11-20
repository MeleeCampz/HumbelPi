/**
 * compact-think — the pure half of compaction-thinking.ts: which thinking level a
 * summarization call should run at, and the save/restore bookkeeping around it.
 * No pi, no fs, no provider — testable on its own (tools/test-compaction-thinking.ts).
 *
 * WHY THIS EXISTS (measured on humbel's own local servers, 2026-11-20, not inferred):
 *
 * 1. Pi summarizes with YOUR thinking level. `createSummarizationOptions` in
 *    pi's dist/core/compaction/compaction.js sets `options.reasoning = thinkingLevel`,
 *    so a session running at `high` compacts at `high` too.
 * 2. The summary request gets no output budget of its own. Its ceiling comes from
 *    pi-ai's clampMaxTokensToContext(): max_tokens = min(model.maxTokens,
 *    contextWindow − input − margin). Every entry in ~/.pi/agent/models.json declares
 *    maxTokens 16384.
 * 3. A local model whose reasoning is uncapped spends that entire ceiling on
 *    reasoning and returns stopReason "length" with NO answer text. Pi then rejects
 *    the summary outright — getSummarizationFailure(): "Summarization failed:
 *    generation hit the token cap and the summary is incomplete" — writes no
 *    CompactionEntry, and re-attempts on the next turn. That is the reported
 *    "auto compaction fails a lot at thinking=high".
 *
 *    Measured on 8890, one reasoning-inducing prompt, max_tokens 400:
 *      thinking on, no cap                     finish "length", thinking 1001 chars, answer truncated
 *      + top-level thinking_budget_tokens 128  finish "stop" — the cap is what makes room for the answer
 *      + chat_template_kwargs.thinking_budget 128   IGNORED: finish "length", answer 0 chars
 *      chat_template_kwargs.enable_thinking false   no reasoning content at all (the "length" there is
 *                                                   just the 400-token ceiling on a long answer; at the
 *                                                   16384 pi really sends it finishes "stop")
 *    And the same request without a cap on 8888 (unsloth 27B, max_tokens 250): finish "length",
 *    reasoning 1123 chars, content "". Same requests with thinking disabled: normal answers, "stop".
 * 4. Even a server that DOES honour a budget gets the wrong number by default. pi-ai's
 *    DEFAULT_THINKING_BUDGETS are minimal 1024 / low 2048 / medium 8192 / high 16384, and
 *    clampThinkingBudgetToAnswerRoom() only trims a budget that would leave less than
 *    MIN_ANSWER_TOKENS = 1024 for the answer. So `high` at these models means 15360 of the
 *    16384 response tokens go to reasoning — an answer squeezed into 1024 tokens, which is how
 *    a normal (non-compaction) turn at high ends up truncated too. Settings →
 *    `thinkingBudgets` is where that gets sized to the model instead (512/1536/3072/6144 here).
 * 5. Which knob a server honours differs per server, so the fix is two-part:
 *      8890 (llama.cpp): top-level `enable_thinking` is IGNORED (thinking runs even at
 *          thinking=off); `chat_template_kwargs.enable_thinking` works, and top-level
 *          `thinking_budget_tokens` caps reasoning (chat_template_kwargs.thinking_budget does not)
 *          → needs the models.json compat fix: thinkingFormat "chat-template",
 *            chatTemplateKwargs {enable_thinking: {$var: thinking.enabled}},
 *            thinkingTokenBudgetField "thinking_budget_tokens".
 *          With that compat, pi's own request builder emits (captured, not guessed):
 *            level off   → chat_template_kwargs {enable_thinking: false}
 *            level high  → {enable_thinking: true} + thinking_budget_tokens <budget>
 *      8888 (unsloth studio): top-level `enable_thinking` works (qwen format, already
 *          configured); neither `thinking_budget` nor `thinking_budget_tokens` is honoured, in the
 *          body or in chat_template_kwargs → thinking is binary there, so the level really has to
 *          go to `off` for a summary to fit its budget.
 *
 * So: keep `high` for the work, drop to `off` (default) for the summary only — and make sure the
 * level actually reaches the server (llamaCppCompat below) and is sized to the model
 * (settings.json thinkingBudgets).
 */

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type LevelName = (typeof LEVELS)[number];

/** "keep" = leave the session's level alone (extension effectively disabled). */
export type Target = LevelName | "keep";

export const DEFAULT_TARGET: Target = "off";
export const LEVEL_ENV = "HUMBEL_PI_COMPACT_THINKING";

const ALIASES: Record<string, Target> = {
	"": DEFAULT_TARGET,
	off: "off",
	none: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	med: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	keep: "keep",
	same: "keep",
	unchanged: "keep",
};

/** Levels pi will actually accept for a reasoning model (xhigh/max are pi's own). */
export function isLevel(value: string): value is LevelName {
	return (LEVELS as readonly string[]).includes(value);
}

/** Pure: one env/config value → a target level, with a warning for anything unknown. */
export function parseTarget(raw: string | undefined): { target: Target; warning?: string } {
	const key = (raw ?? "").trim().toLowerCase();
	if (key === "") return { target: DEFAULT_TARGET };
	const target = ALIASES[key];
	if (!target) {
		return {
			target: DEFAULT_TARGET,
			warning: `unknown level "${raw}" — using ${DEFAULT_TARGET}. Valid: ${LEVELS.join(", ")} or keep`,
		};
	}
	return { target };
}

export function readConfig(env: Record<string, string | undefined>): { target: Target; warning?: string } {
	return parseTarget(env[LEVEL_ENV]);
}

/** What we are holding: the level to put back, and the one we forced on the summary. */
export interface Hold {
	saved: LevelName | null;
	forced: LevelName | null;
}

export const idleHold: Hold = { saved: null, forced: null };

export function isHolding(hold: Hold): boolean {
	return hold.saved !== null && hold.forced !== null;
}

/**
 * Pure: decide whether a compaction has to move the level.
 * No change when the target is "keep" or the level already matches — a compaction at
 * `off` in a session already at `off` must not append a level-change entry pair.
 */
export function planHold(current: LevelName, target: Target): { hold: Hold; changed: boolean } {
	if (target === "keep") return { hold: idleHold, changed: false };
	if (current === target) return { hold: idleHold, changed: false };
	return { hold: { saved: current, forced: target }, changed: true };
}

/**
 * Pure: pi clamps a level to what the model supports, so the level we asked for is not
 * always the level we got. Re-read it after setting and hold THAT, otherwise release
 * would think the user had changed it and leave the clamped level in place.
 */
export function reconcileHold(planned: Hold, effective: LevelName): Hold {
	if (!isHolding(planned)) return idleHold;
	return { saved: planned.saved, forced: effective };
}

export type ReleaseSkip = "not-held" | "changed-elsewhere";

/**
 * Pure: the level to restore, or a reason not to touch it.
 * `changed-elsewhere` is the important one: if the level moved while the summary ran
 * (a model switch re-picks a level per model; a keypress `/think` also counts) the
 * human/model owns it now — restoring the pre-compaction value would fight them.
 */
export function planRelease(hold: Hold, current: LevelName): { level: LevelName | null; skipped?: ReleaseSkip } {
	if (!isHolding(hold)) return { level: null, skipped: "not-held" };
	if (current !== hold.forced) return { level: null, skipped: "changed-elsewhere" };
	return { level: hold.saved };
}

export interface CompactFailedLike {
	reason: "manual" | "threshold" | "overflow";
	aborted: boolean;
	errorMessage?: string;
	fromExtension: boolean;
}

/** Pure: one-line notice for a failed compaction, or null when there is nothing to say. */
export function failureNotice(e: CompactFailedLike): string | null {
	if (e.aborted) return null;
	const reason = e.reason === "threshold" ? "auto-compaction" : e.reason === "overflow" ? "overflow recovery" : "/compact";
	const tail = e.fromExtension ? " (extension summary)" : "";
	return `${reason} failed${tail}: ${e.errorMessage ?? "unknown error"}`;
}

/** Pure: `/compact-think` status line. */
export function holdStatus(hold: Hold, target: Target, current: LevelName): string {
	const mode = target === "keep" ? "kept as-is" : `summarize at "${target}"`;
	const holding = isHolding(hold)
		? ` — mid-compaction, "${current}" in place, will restore "${hold.saved}"`
		: "";
	return `compaction thinking: ${mode}${holding} (session level now "${current}")`;
}

/** Pure: the compat a llama.cpp endpoint needs for a thinking level to mean anything. */
export const llamaCppCompat = {
	thinkingFormat: "chat-template",
	chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
	thinkingTokenBudgetField: "thinking_budget_tokens",
} as const;
