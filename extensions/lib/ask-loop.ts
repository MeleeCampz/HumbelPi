/**
 * ask-loop — the pure "pick an option, or type your own — and get back to the options" loop.
 *
 * Why this exists: both ask_user and the finish_plan approval dialog used to show the option
 * list ONCE, then drop the user into a free-text box that only knew Enter (submit) and Esc
 * (cancel). Picking "Other" was a one-way door — changing your mind meant cancelling out and
 * hoping the agent re-asked (HumbelPi #3 is the plan-approval case).
 *
 * Flow now:  select → (option | Other → answer box), and the answer box can send you BACK to
 * the same option list with what you typed so far kept as a draft. Trips are unlimited apart
 * from a safety valve, and every trip re-shows the identical list.
 *
 *   option list : Enter pick · Esc/Ctrl+C dismiss    (pi's built-in select, unchanged)
 *   answer box  : Enter submit · Esc back to the options (draft kept) · Ctrl+C cancel everything
 *   no-key modes: type "!back" / "!cancel" instead
 *
 * Plain helper module: no runtime imports (types only) and registers/creates nothing, so
 * tools/*.ts regression tests can exercise the loop without dragging in the extension graph
 * (same rule as plan-file.ts). The pi-UI side lives in ask-flow.ts.
 */

/** What the free-text stage returns. */
export interface DialogAnswer {
	/** What the user typed. Present even on a back trip, so the draft survives. */
	text?: string;
	/** true = go back to the option list, keeping `text` as the draft. */
	back: boolean;
}

export type AskOutcome =
	| { kind: "option"; text: string }
	| { kind: "custom"; text: string }
	/** Cancelled — either at the list or from inside the answer box. */
	| { kind: "dismissed"; stage: "options" | "answer" };

/** The two UI calls the loop needs. Fake-able in tests, wired to ctx.ui by ask-flow.ts. */
export interface AskHost {
	select(question: string, options: string[]): Promise<string | undefined>;
	answer(o: { title: string; placeholder: string; draft?: string; backLabel?: string }): Promise<DialogAnswer>;
}

export interface AskOptions {
	/** Question/header shown above the option list. */
	question: string;
	/** The presets, always re-shown in the same order. */
	options: string[];
	/** The entry that opens the free-text stage. */
	otherLabel: string;
	answerTitle: string;
	answerPlaceholder: string;
	/** Hint text for the back key, e.g. "back to Approve / Keep planning". */
	backLabel?: string;
}

/** Non-TUI modes (rpc/print) have no key channel, so they type these. */
export const BACK_LITERAL = "!back";
export const CANCEL_LITERAL = "!cancel";

/** Interpret a plain input line from a mode that has no Esc/Ctrl+C. */
export function parseLiteralAnswer(value: string | undefined): DialogAnswer {
	if (value === undefined) return { back: false }; // dismissed outright = cancel, not back
	const trimmed = value.trim();
	if (trimmed === BACK_LITERAL) return { text: value, back: true };
	if (trimmed === CANCEL_LITERAL) return { back: false };
	return { text: value, back: false };
}

/**
 * Safety valve: a host whose dialogs resolve instantly without real user input (a stubbed or
 * headless implementation) must not spin this loop forever. 25 trips is far past any human.
 */
export const MAX_BACK_TRIPS = 25;

export async function runAskLoop(host: AskHost, o: AskOptions): Promise<AskOutcome> {
	let draft: string | undefined;
	for (let trip = 0; trip < MAX_BACK_TRIPS; trip++) {
		// The list is rebuilt identically on every trip (and `otherLabel` never appears twice,
		// so a caller may list it among `options` for clarity).
		const list = [...o.options.filter((x) => x !== o.otherLabel), o.otherLabel];
		const choice = await host.select(o.question, list);
		if (choice === undefined) return { kind: "dismissed", stage: "options" };
		if (choice !== o.otherLabel) return { kind: "option", text: choice };

		const answer = await host.answer({
			title: o.answerTitle,
			placeholder: o.answerPlaceholder,
			draft,
			backLabel: o.backLabel,
		});
		if (answer.back) {
			// Keep whatever they typed (including an intentional clear) for the next trip.
			if (answer.text !== undefined) draft = answer.text;
			continue;
		}
		const text = (answer.text ?? "").trim();
		if (!text) return { kind: "dismissed", stage: "answer" };
		return { kind: "custom", text };
	}
	return { kind: "dismissed", stage: "options" };
}
