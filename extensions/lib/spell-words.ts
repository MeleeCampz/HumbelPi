/**
 * spell-words — the typo RULE, separated from the dictionary and from pi.
 *
 * Why its own module: the rule ("which words in this text are not real words") is pure — it takes
 * the text and a Set, and returns the flagged lowercased words. Keeping it out of spellcheck.ts
 * means a regression test can pin the rule itself (CamelCase exemption, the <=2-letter skip, the
 * per-message cap) without loading the 370k-word dictionary file or pi-coding-agent at all. It is
 * also what both hosts share: the main editor and the free-text dialog boxes flag the SAME words,
 * because they call the SAME function with the SAME dictionary — a looser rule in a dialog would
 * make the same word red in one place and clean in another.
 *
 * What is deliberately NOT here: dictionary loading, the ignore file, the on/off state and any
 * rendering — those belong to the extension entry (spellcheck.ts).
 */

/**
 * Set of words in `text` that are not in `dictionary`.
 *
 * Skips, on purpose: words shorter than 3 letters (too many legitimate 2-letter words, too much
 * noise for a red squiggle), CamelCase / ALLCAPS tokens (in this repo's daily use those are
 * identifiers, class names or acronyms — pi, HumbelPi, SQLite — not typos), and stops at 40 flagged
 * words so a wall of unknown text cannot cost a render per word.
 */
export function unknownWords(text: string, dictionary: Set<string>): Set<string> {
	const out = new Set<string>();
	const seen = new Set<string>();
	for (const m of text.matchAll(/[A-Za-z]{3,}/g)) {
		const tok = m[0];
		const lower = tok.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		if (/[A-Z]/.test(tok.slice(1))) continue; // CamelCase / ALLCAPS → identifier or acronym
		if (!dictionary.has(lower)) out.add(lower);
		if (out.size >= 40) break; // sanity cap per message
	}
	return out;
}
