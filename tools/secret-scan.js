#!/usr/bin/env node
/**
 * secret-scan.js — aborts if anything that looks private is in what git would publish.
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
 * WHAT IT SCANS: a pre-push hook has to look at what the push can actually carry, so by
 * default it scans the files git would publish — the index (`git ls-files`) plus untracked files
 * that are NOT gitignored (`git ls-files --others --exclude-standard`: one `git add -A` away
 * from being published). It deliberately does NOT walk the whole working tree: pi writes
 * plan/session files under .pi/ that legitimately contain your own paths, and those files are
 * never pushed — scanning them made every push abort on a false positive.
 *
 * Usage:
 *   node tools/secret-scan.js [dir]        scan what git would publish (default; the hook mode)
 *   node tools/secret-scan.js [dir] --all  audit every file on disk, gitignore ignored or not
 *
 * Run outside a git repository and it falls back to --all (with a warning) rather than silently
 * scanning nothing.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT_DEFAULT = process.cwd();

const PLACEHOLDER_KEYS = new Set(["", "replace_with_your_api_key", "your-api-key", "your_api_key", "<api-key>", "<your-api-key>", "changeme", "xxx"]);

// [label, regex] — each match is a potential leak (all global)
const PATTERNS = [
	["sk-… key", /sk-[A-Za-z0-9_-]{16,}/g],
	["PEM private key", /BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY/g],
	["Bearer token", /Bearer [A-Za-z0-9._~+-]{16,}/g],
	// JWTs (Home Assistant long-lived tokens, OAuth access tokens, Slack signin tokens…) — these
	// are the shape a "just paste the token in the README" accident takes.
	["JWT token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g],
	["Windows user path", /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/g],
];

// apiKey field in JSON — flag any value that is not a known placeholder
const APIKEY_RE = /"apiKey"\s*:\s*"([^"]*)"/g;

const FORBIDDEN_FILES = new Set(["auth.json", "models.json", "trust.json", "guard-state.json", "spell-ignore.txt"]);
const FORBIDDEN_DIRS = new Set(["sessions", "plans"]);
// Never part of a push even when a repo forgets to ignore them.
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Forbidden by NAME (file) or by any path component (directory). */
function forbiddenReason(rel) {
	const parts = rel.split(path.sep);
	const base = parts[parts.length - 1];
	if (FORBIDDEN_FILES.has(base)) return `forbidden file (${base})`;
	for (const p of parts.slice(0, -1)) {
		if (FORBIDDEN_DIRS.has(p)) return `forbidden directory (${p}/)`;
	}
	return null;
}

function skipped(rel) {
	return rel.split(path.sep).some((p) => SKIP_DIRS.has(p));
}

/** Every leak in one file's text: "<rel>:<line> — <label>: <match>". */
function scanText(rel, text) {
	const out = [];
	if (text.includes("\u0000")) return out; // binary
	for (const [label, re] of PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(text))) {
			const line = text.slice(0, m.index).split("\n").length;
			out.push(`${rel}:${line} — ${label}: ${m[0].slice(0, 40)}`);
			if (m.index === re.lastIndex) re.lastIndex++; // zero-width match safety
		}
	}
	let m;
	APIKEY_RE.lastIndex = 0;
	while ((m = APIKEY_RE.exec(text))) {
		if (!PLACEHOLDER_KEYS.has(m[1].toLowerCase())) {
			const line = text.slice(0, m.index).split("\n").length;
			out.push(`${rel}:${line} — non-placeholder apiKey value: ${m[1].slice(0, 8)}…`);
		}
		if (m.index === APIKEY_RE.lastIndex) APIKEY_RE.lastIndex++;
	}
	return out;
}

/** NUL-safe: paths with quotes/spaces come out exactly as git stored them. */
function gitList(root, args) {
	const raw = execFileSync("git", ["-C", root, ...args, "-z"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
	return raw.split("\0").filter(Boolean);
}

/**
 * What a push could carry: index + untracked-but-not-ignored.
 * Throws if `root` is not a git repository (caller falls back to --all).
 */
function publishablePaths(root) {
	const tracked = gitList(root, ["ls-files"]);
	const fresh = gitList(root, ["ls-files", "--others", "--exclude-standard"]);
	return { tracked, fresh };
}

/** Whole-tree audit: every file on disk, ignored or not (the old filesystem-wide behaviour). */
function walkAll(root, dir = root, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(e.name)) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkAll(root, p, out);
		else if (e.isFile()) out.push(path.relative(root, p));
	}
	return out;
}

/** Scan `root`; returns { hits, files, mode }. */
function scan(root, mode) {
	const hits = [];
	let rel = [];
	let used = mode;
	if (mode === "git") {
		try {
			const { tracked, fresh } = publishablePaths(root);
			rel = [...new Set([...tracked, ...fresh])];
		} catch {
			console.warn("secret-scan: not a git repository — auditing every file on disk instead");
			rel = walkAll(root);
			used = "all";
		}
	} else {
		rel = walkAll(root);
	}

	const files = [];
	for (const r of rel) {
		if (skipped(r)) continue;
		files.push(r);
		const why = forbiddenReason(r);
		if (why) {
			// The name alone is the finding: these hold runtime/private data and must not be published.
			hits.push(`${r} — ${why}`);
			continue;
		}
		let text;
		try {
			text = fs.readFileSync(path.join(root, r), "utf8");
		} catch {
			continue; // deleted from the index, or unreadable — the name check already ran
		}
		hits.push(...scanText(r, text));
	}
	return { hits, files: files.length, mode: used };
}

function main() {
	const argv = process.argv.slice(2);
	const mode = argv.includes("--all") ? "all" : "git";
	const dirArg = argv.find((a) => !a.startsWith("--"));
	const root = path.resolve(dirArg || ROOT_DEFAULT);
	const { hits, files, mode: used } = scan(root, mode);

	if (hits.length) {
		console.error(`secret-scan: ${hits.length} potential leak(s):\n`);
		for (const h of hits) console.error("  " + h);
		console.error("\nRemove the flagged content before pushing (this repo is public).");
		console.error(`(scanned ${files} file(s) in ${used === "git" ? "push-scope: tracked + non-ignored new files" : "whole-tree --all"} mode; ${root})`);
		process.exit(1);
	}
	const note = used === "git" ? "push-scope: tracked + non-ignored new files" : "whole tree";
	console.log(`secret-scan: clean — ${files} file(s), ${note} (${root})`);
	console.log("tip: node tools/secret-scan.js --all audits ignored files too (plan files, sessions, press logs).");
}

if (require.main === module) main();

module.exports = { scan, scanText, forbiddenReason, publishablePaths, walkAll, PATTERNS, FORBIDDEN_FILES, FORBIDDEN_DIRS };
