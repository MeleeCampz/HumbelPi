#!/usr/bin/env node
/**
 * secret-scan.js — aborts if anything that looks private is in the repo tree.
 *
 * This repository is PUBLIC. The scan covers:
 *   - API-key-shaped strings            sk-… (16+ chars)
 *   - non-placeholder "apiKey" values   any value that is not an obvious placeholder
 *   - PEM private keys                  BEGIN … PRIVATE KEY
 *   - Bearer tokens                     Bearer … (16+ chars)
 *   - user-specific paths               C:\Users\<name> (username required)
 *   - forbidden filenames               auth.json, models.json (not .example), trust.json,
 *                                       guard-state.json, spell-ignore.txt, sessions/, plans/
 *
 * All patterns are /g — a non-global exec() would loop forever on the first match.
 *
 * Usage:  node tools/secret-scan.js [dir]     (default: repo root)
 * Wired as the pre-push hook (.githooks/pre-push).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || process.cwd());

const PLACEHOLDER_KEYS = new Set(["", "replace_with_your_api_key", "your-api-key", "your_api_key", "<api-key>", "<your-api-key>", "changeme", "xxx"]);

// [label, regex] — each match is a potential leak (all global)
const PATTERNS = [
	["sk-… key", /sk-[A-Za-z0-9_-]{16,}/g],
	["PEM private key", /BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY/g],
	["Bearer token", /Bearer [A-Za-z0-9._~+-]{16,}/g],
	["Windows user path", /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/g],
];

// apiKey field in JSON — flag any value that is not a known placeholder
const APIKEY_RE = /"apiKey"\s*:\s*"([^"]*)"/g;

const FORBIDDEN_FILES = new Set(["auth.json", "models.json", "trust.json", "guard-state.json", "spell-ignore.txt"]);
const FORBIDDEN_DIRS = new Set(["sessions", "plans"]);

function walk(dir, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".git" || e.name === "node_modules") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (FORBIDDEN_DIRS.has(e.name)) out.push({ dir: p });
			walk(p, out);
		} else if (e.isFile()) {
			if (FORBIDDEN_FILES.has(e.name)) out.push({ file: p, forbidden: e.name });
			else out.push({ file: p });
		}
	}
	return out;
}

const hits = [];
for (const entry of walk(ROOT, [])) {
	if (entry.dir) {
		hits.push(`${path.relative(ROOT, entry.dir)}/ — forbidden directory (runtime data)`);
		continue;
	}
	if (entry.forbidden) {
		hits.push(`${path.relative(ROOT, entry.file)} — forbidden file (${entry.forbidden})`);
		continue;
	}
	let text;
	try {
		text = fs.readFileSync(entry.file, "utf8");
	} catch {
		continue; // binary or unreadable — name check already passed
	}
	if (text.includes("\u0000")) continue; // binary
	const rel = path.relative(ROOT, entry.file);
	for (const [label, re] of PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(text))) {
			const line = text.slice(0, m.index).split("\n").length;
			hits.push(`${rel}:${line} — ${label}: ${m[0].slice(0, 40)}`);
			if (m.index === re.lastIndex) re.lastIndex++; // zero-width match safety
		}
	}
	let m;
	APIKEY_RE.lastIndex = 0;
	while ((m = APIKEY_RE.exec(text))) {
		if (!PLACEHOLDER_KEYS.has(m[1].toLowerCase())) {
			const line = text.slice(0, m.index).split("\n").length;
			hits.push(`${rel}:${line} — non-placeholder apiKey value: ${m[1].slice(0, 8)}…`);
		}
		if (m.index === APIKEY_RE.lastIndex) APIKEY_RE.lastIndex++;
	}
}

if (hits.length) {
	console.error(`secret-scan: ${hits.length} potential leak(s):\n`);
	for (const h of hits) console.error("  " + h);
	console.error("\nRemove the flagged content before pushing (this repo is public).");
	process.exit(1);
}
console.log(`secret-scan: clean (${ROOT})`);
