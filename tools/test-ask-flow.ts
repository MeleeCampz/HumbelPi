/**
 * Regression test for the ask loop (extensions/lib/ask-loop.ts): "Other — I'll type my own
 * answer" used to be a one-way door — Esc in the answer box just returned "no answer" and the
 * preset list was gone. It must now be able to send you back to the SAME list, keeping the
 * draft, while Ctrl+C (or "!cancel" without a key channel) stays a real cancel.
 *
 * Run: npx tsx tools/test-ask-flow.ts        (or: node --experimental-strip-types tools/test-ask-flow.ts)
 * Exit code 0 = all pass. No terminal, no pi runtime — the loop is pure by design.
 */
import {
	BACK_LITERAL,
	CANCEL_LITERAL,
	MAX_BACK_TRIPS,
	parseLiteralAnswer,
	runAskLoop,
	type AskHost,
	type AskOptions,
	type AskOutcome,
	type DialogAnswer,
} from "../extensions/lib/ask-loop.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  PASS  ${name}`);
	else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const OPTIONS = ["Option A", "Option B"];
const OTHER = "Other — I'll type my own answer";
const BASE: AskOptions = {
	question: "Which way?",
	options: OPTIONS,
	otherLabel: OTHER,
	answerTitle: "Your answer",
	answerPlaceholder: "Type your own answer…",
};

/** Scripted host: `selects` feeds ctx.ui.select, `answers` feeds the free-text dialog. */
class FakeHost implements AskHost {
	readonly selectLog: { question: string; options: string[] }[] = [];
	readonly answerLog: { title: string; placeholder: string; draft?: string; backLabel?: string }[] = [];

	constructor(
		private selects: (string | undefined)[],
		private answers: DialogAnswer[] = [],
	) {}

	async select(question: string, options: string[]): Promise<string | undefined> {
		this.selectLog.push({ question, options });
		if (this.selects.length === 0) throw new Error("select script exhausted");
		return this.selects.shift();
	}

	async answer(o: { title: string; placeholder: string; draft?: string; backLabel?: string }): Promise<DialogAnswer> {
		this.answerLog.push(o);
		if (this.answers.length === 0) throw new Error("answer script exhausted");
		return this.answers.shift() as DialogAnswer;
	}
}

async function ask(overrides: Partial<AskOptions> = {}, ...args: ConstructorParameters<typeof FakeHost>) {
	const host = new FakeHost(...args);
	const outcome = await runAskLoop(host, { ...BASE, ...overrides });
	return { outcome, host };
}

const text = (o: AskOutcome): string => (o.kind === "option" || o.kind === "custom" ? o.text : "");

void (async () => {
	// ── 1. picking a preset never opens the free-text box ──
	{
		const { outcome, host } = await ask({}, [OPTIONS[1]]);
		check("preset pick -> option outcome", outcome.kind === "option" && text(outcome) === OPTIONS[1]);
		check("preset pick -> other appended last", host.selectLog[0]!.options.join("|") === [...OPTIONS, OTHER].join("|"));
		check("preset pick -> answer box untouched", host.answerLog.length === 0);
	}

	// ── 2. the fix itself: Other -> Esc back -> pick a preset ──
	{
		const { outcome, host } = await ask({}, [OTHER, OPTIONS[0]], [{ text: "half an answer", back: true }]);
		check("Other then back -> list comes back", host.selectLog.length === 2);
		check("Other then back -> same options, same order", host.selectLog[0]!.options.join("|") === host.selectLog[1]!.options.join("|"));
		check("Other then back -> same question header", host.selectLog[0]!.question === host.selectLog[1]!.question);
		check("back then preset -> option outcome", outcome.kind === "option" && text(outcome) === OPTIONS[0]);
	}

	// ── 3. the draft survives the trip out and the trip back in ──
	{
		const { host, outcome } = await ask(
			{},
			[OTHER, OTHER, OTHER, OPTIONS[1]],
			[{ text: "use SQLite", back: true }, { text: "use SQLite instead", back: true }, { text: "use SQLite instead of JSON", back: false }],
		);
		check("first box starts empty", host.answerLog[0]!.draft === undefined, JSON.stringify(host.answerLog[0]));
		check("draft kept across 1st back trip", host.answerLog[1]!.draft === "use SQLite", JSON.stringify(host.answerLog[1]));
		check("draft kept across 2nd back trip", host.answerLog[2]!.draft === "use SQLite instead", JSON.stringify(host.answerLog[2]));
		check("submitting after two trips returns the accumulated text", outcome.kind === "custom" && text(outcome) === "use SQLite instead of JSON", text(outcome));
	}

	// ── 4. an intentional clear is respected (no zombie draft) ──
	{
		const { outcome, host } = await ask(
			{},
			[OTHER, OTHER, OTHER],
			[{ text: "oops", back: true }, { text: "", back: true }, { text: "", back: false }],
		);
		check("2nd box was prefilled with the draft", host.answerLog[1]!.draft === "oops", JSON.stringify(host.answerLog[1]));
		check("clearing the box then backing out carries an empty draft", host.answerLog[2]!.draft === "", JSON.stringify(host.answerLog[2]));
		check("empty submit -> dismissed, not an answer", outcome.kind === "dismissed" && outcome.stage === "answer");
	}

	// ── 5. typed answer wins over the presets ──
	{
		const { outcome } = await ask({}, [OTHER], [{ text: "  do it with SQLite  ", back: false }]);
		check("typed answer -> custom outcome", outcome.kind === "custom" && text(outcome) === "do it with SQLite", text(outcome));
	}

	// ── 6. Ctrl+C out of the box is a cancel, not a back trip ──
	{
		const { outcome, host } = await ask({}, [OTHER], [{ back: false }]);
		check("cancel from the box -> dismissed at the answer stage", outcome.kind === "dismissed" && outcome.stage === "answer");
		check("cancel from the box -> list NOT re-shown", host.selectLog.length === 1);
	}

	// ── 7. dismissing at the list still means "no answer" ──
	{
		const { outcome, host } = await ask({}, [undefined]);
		check("dismiss at the list -> dismissed at the options stage", outcome.kind === "dismissed" && outcome.stage === "options");
		check("dismiss at the list -> no answer box", host.answerLog.length === 0);
	}

	// ── 8. whitespace-only typing is not an answer ──
	{
		const { outcome } = await ask({}, [OTHER], [{ text: "   \t ", back: false }]);
		check("whitespace answer -> dismissed", outcome.kind === "dismissed" && outcome.stage === "answer");
	}

	// ── 9. otherLabel listed among options is not shown twice ──
	{
		const { host } = await ask({ options: ["A", "B", OTHER] }, ["A"]);
		check("no duplicate 'Other' row", host.selectLog[0]!.options.filter((o) => o === OTHER).length === 1, host.selectLog[0]!.options.join("|"));
		check("option order preserved", host.selectLog[0]!.options.join("|") === ["A", "B", OTHER].join("|"));
	}

	// ── 10. backLabel is passed through for the hint row ──
	{
		const { host } = await ask({ backLabel: "back to Approve / Keep planning" }, [OTHER], [{ back: false }]);
		check("backLabel reaches the dialog", host.answerLog[0]!.backLabel === "back to Approve / Keep planning");
		check("title/placeholder reach the dialog", host.answerLog[0]!.title === BASE.answerTitle && host.answerLog[0]!.placeholder === BASE.answerPlaceholder);
	}

	// ── 11. modes with no key channel: the literals drive the same flow ──
	{
		const literalHost = (inputs: (string | undefined)[]): AskHost & { log: (string | undefined)[] } => {
			const log: (string | undefined)[] = [];
			let i = 0;
			return {
				log,
				async select(_q, _o) { return i++ % 2 === 0 ? OTHER : undefined; },
				async answer() { const v = inputs.shift(); log.push(v); return parseLiteralAnswer(v); },
			};
		};
		{
			const h = literalHost([BACK_LITERAL]);
			const o = await runAskLoop(h, { ...BASE, options: ["A"] });
			check(`"${BACK_LITERAL}" from the box goes back to the list`, h.log.length === 1 && o.kind === "dismissed" && o.stage === "options");
		}
		{
			const h = literalHost([CANCEL_LITERAL]);
			const o = await runAskLoop(h, BASE);
			check(`"${CANCEL_LITERAL}" from the box cancels`, o.kind === "dismissed" && o.stage === "answer");
		}
		{
			const h = literalHost(["  a real answer  "]);
			const o = await runAskLoop(h, BASE);
			check("plain text from the box is the answer", o.kind === "custom" && o.text === "a real answer", JSON.stringify(o));
		}
		{
			const h = literalHost([undefined]);
			const o = await runAskLoop(h, BASE);
			check("dismissed plain input -> cancel, not back", o.kind === "dismissed" && o.stage === "answer");
		}
		check(`a literal "!backword" is an answer, not the back command`, parseLiteralAnswer("!backword").back === false);
	}

	// ── 12. safety valve: a host that never blocks must not spin forever ──
	{
		let calls = 0;
		const spin: AskHost = {
			async select() { calls++; return OTHER; },
			async answer() { return { text: "x", back: true }; },
		};
		const outcome = await runAskLoop(spin, BASE);
		check("spin host terminates", outcome.kind === "dismissed");
		check(`spin host stops at MAX_BACK_TRIPS (${MAX_BACK_TRIPS})`, calls === MAX_BACK_TRIPS, `calls=${calls}`);
	}

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
})();
