/**
 * ask-user — check-in with the user before important decisions.
 *
 * Registers an `ask_user` tool: when the agent is about to make a significant
 * assumption or decision, it presents the user with a list of concrete
 * options plus an "Other" escape hatch for a free-text answer. The chosen
 * answer comes back as the tool result and the agent proceeds with it.
 *
 * The answer box is not a one-way door: Esc re-shows the same option list with the
 * draft kept, Ctrl+C cancels the question (loop lives in lib/ask-loop.ts).
 *
 * Global extension: applies to every project.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askWithOther, BACK_LITERAL, CANCEL_LITERAL } from "./lib/ask-flow";

const OTHER = "Other — I'll type my own answer";

// Per-session state (schema owner: guards.ts) — duplicated per the backlog.ts pattern.
// #4: unattended mode is per session (own file keyed by session id), so questions are
// only auto-rejected in the console where /away was turned on.
const SESSION_STATE_DIR = path.join(os.homedir(), ".pi", "agent", "session-state");
function isUnattended(sessionId: string): boolean {
	try {
		const f = path.join(SESSION_STATE_DIR, `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
		return (JSON.parse(fs.readFileSync(f, "utf8")) as { unattendedMode?: boolean }).unattendedMode === true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Present the user with a decision: a short question plus 2-5 concrete options. " +
			"The user picks one option or types a custom answer. Returns their choice verbatim. " +
			"In the free-text box Esc goes back to the options (what they typed is kept) and Ctrl+C cancels the question. " +
			"Use ONLY for decisions that are important, hard to reverse, or where the request is ambiguous. " +
			"Do NOT use for trivial implementation details — just make those yourself.",
		promptSnippet:
			"ask_user(question, options) — check in with the user before important/ambiguous/hard-to-reverse decisions; they pick an option or type their own answer",
		promptGuidelines: [
			"Before making a decision that is important, hard to reverse, or based on an assumption the user might disagree with (architecture choices, deleting/replacing existing behavior, picking between multiple valid approaches, spending significant time on one interpretation), call ask_user with 2-5 concrete options and wait for the answer.",
			"Each option must be short (one line) and self-contained; include a recommended option first and mark it '(recommended)' if you have a clear preference.",
			"After receiving the answer, proceed exactly along the user's choice. If they typed a custom answer, follow it literally — do not fall back to your original plan.",
			"The answer box is not a one-way door: Esc there re-shows the same options with their draft kept, Ctrl+C cancels outright. Treat a dismissed result as 'they chose not to answer', never as an answer.",
			"Do NOT call ask_user for trivial details (naming, formatting, small implementation choices) or when the user has already decided. At most 1-2 check-ins per task unless the work genuinely branches again.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "Short question describing the decision" }),
			options: Type.Array(Type.String(), {
				minItems: 2,
				maxItems: 5,
				description: "Concrete options for the user to pick from (2-5, one line each)",
			}),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (isUnattended(ctx.sessionManager.getSessionId())) {
				return {
					content: [
						{
							type: "text",
							text: `The user is away (unattended mode) — this question was auto-rejected. Do not wait and do not re-ask the same decision. Pick the safest reasonable option, state your assumption explicitly, and record it in a "Decisions made while unattended" section of your final report.`,
						},
					],
					details: undefined,
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `No interactive UI available. Question was: "${params.question}" Options: ${params.options.join(" | ")}. Proceed with your best judgment and state the assumption you are making.`,
						},
					],
					details: undefined,
				};
			}
			const outcome = await askWithOther(ctx, {
				question: params.question,
				options: params.options,
				otherLabel: OTHER,
				answerTitle: "Your answer",
				answerPlaceholder: `Type your own answer… (${BACK_LITERAL} returns to the options, ${CANCEL_LITERAL} cancels)`,
			});
			switch (outcome.kind) {
				case "option":
					return { content: [{ type: "text", text: `User chose: ${outcome.text}` }], details: undefined };
				case "custom":
					return { content: [{ type: "text", text: `User's custom answer: ${outcome.text}` }], details: undefined };
				default:
					// Two ways to get here: dismissed at the list, or Ctrl+C out of the answer box
					// (Esc there means "back to the options", so a cancel is deliberate).
					return {
						content: [{
							type: "text",
							text: outcome.stage === "options"
								? "User dismissed the dialog without choosing. Do not proceed with this decision; ask again later or pick the safest option and say so."
								: "User opened the free-text answer box, then cancelled out of it without answering. Do not proceed with this decision; ask again later or pick the safest option and say so.",
						}],
						details: undefined,
					};
			}
		},
	});
}
