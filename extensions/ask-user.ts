/**
 * ask-user — check-in with the user before important decisions.
 *
 * Registers an `ask_user` tool: when the agent is about to make a significant
 * assumption or decision, it presents the user with a list of concrete
 * options plus an "Other" escape hatch for a free-text answer. The chosen
 * answer comes back as the tool result and the agent proceeds with it.
 *
 * Global extension: applies to every project.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OTHER = "Other — I'll type my own answer";

// Shared guard state (schema owner: guards.ts) — duplicated per the backlog.ts pattern.
// Unattended mode: the user is away, so questions are auto-rejected instead of hanging.
const GUARD_STATE_FILE = path.join(os.homedir(), ".pi", "agent", "guard-state.json");
function isUnattended(): boolean {
	try {
		return (JSON.parse(fs.readFileSync(GUARD_STATE_FILE, "utf8")) as { unattendedMode?: boolean }).unattendedMode === true;
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
			"Use ONLY for decisions that are important, hard to reverse, or where the request is ambiguous. " +
			"Do NOT use for trivial implementation details — just make those yourself.",
		promptSnippet:
			"ask_user(question, options) — check in with the user before important/ambiguous/hard-to-reverse decisions; they pick an option or type their own answer",
		promptGuidelines: [
			"Before making a decision that is important, hard to reverse, or based on an assumption the user might disagree with (architecture choices, deleting/replacing existing behavior, picking between multiple valid approaches, spending significant time on one interpretation), call ask_user with 2-5 concrete options and wait for the answer.",
			"Each option must be short (one line) and self-contained; include a recommended option first and mark it '(recommended)' if you have a clear preference.",
			"After receiving the answer, proceed exactly along the user's choice. If they typed a custom answer, follow it literally — do not fall back to your original plan.",
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
			if (isUnattended()) {
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
			const choice = await ctx.ui.select(params.question, [...params.options, OTHER]);
			if (choice === undefined) {
				return {
					content: [{ type: "text", text: "User dismissed the dialog without choosing. Do not proceed with this decision; ask again later or pick the safest option and say so." }],
					details: undefined,
				};
			}
			if (choice !== OTHER) {
				return { content: [{ type: "text", text: `User chose: ${choice}` }], details: undefined };
			}
			const custom = await ctx.ui.input("Your answer", "Type your own answer…");
			if (custom === undefined || custom.trim() === "") {
				return {
					content: [{ type: "text", text: "User chose 'Other' but gave no answer. Do not proceed with this decision; ask again or pick the safest option and say so." }],
					details: undefined,
				};
			}
			return { content: [{ type: "text", text: `User's custom answer: ${custom.trim()}` }], details: undefined };
		},
	});
}
