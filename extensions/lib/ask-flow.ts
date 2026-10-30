/**
 * ask-flow — the pi-UI side of the ask loop (the loop itself is pure: ask-loop.ts).
 *
 * Wires ctx.ui into runAskLoop():
 *   option list  → ctx.ui.select (pi built-in: Enter pick, Esc/Ctrl+C dismiss)
 *   answer box   → TUI: the spellchecked input dialog (Enter submit, Esc back to the options
 *                  with the draft kept, Ctrl+C cancel the whole question)
 *                  other modes: ctx.ui.input plus the "!back" / "!cancel" literals
 *
 * Plain helper module — registers nothing. Used by ask-user.ts (ask_user) and guards.ts
 * (finish_plan approval), which is the point: the same back affordance in both dialogs.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSpellcheckInputDialog } from "../spellcheck";
import { parseLiteralAnswer, runAskLoop } from "./ask-loop";
import type { AskHost, AskOptions, AskOutcome, DialogAnswer } from "./ask-loop";

export type { AskHost, AskOptions, AskOutcome, DialogAnswer } from "./ask-loop";
export { BACK_LITERAL, CANCEL_LITERAL, MAX_BACK_TRIPS, parseLiteralAnswer, runAskLoop } from "./ask-loop";

/** ctx.ui-backed host for the loop. Exported so callers/tests can drive the loop by hand. */
export function makeAskHost(ctx: ExtensionContext): AskHost {
	return {
		select: (question, options) => ctx.ui.select(question, options),
		answer: async ({ title, placeholder, draft, backLabel }) => {
			// Non-TUI modes (rpc/print) have no Esc/Ctrl+C — they get the typed literals.
			if (ctx.mode !== "tui") return parseLiteralAnswer(await ctx.ui.input(title, placeholder));
			return await ctx.ui.custom<DialogAnswer>((_tui, theme, _kb, done) =>
				createSpellcheckInputDialog(theme, title, placeholder, done, { draft, backLabel }));
		},
	};
}

/** The whole flow: presets + "Other" free text + a way back to the presets. */
export function askWithOther(ctx: ExtensionContext, o: AskOptions): Promise<AskOutcome> {
	return runAskLoop(makeAskHost(ctx), o);
}
