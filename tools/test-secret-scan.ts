/**
 * Regression test for tools/secret-scan.js (the pre-push guard).
 *
 * What it must never regress into:
 *  - scanning the WHOLE working tree → every push aborts on files git would never publish
 *    (pi writes .pi/PLAN.md with your own C:\Users\… paths; that is not a leak, it is a
 *    private scratch file, and it blocked every push).
 *  - the opposite mistake: scanning only committed files, so an untracked-but-not-ignored
 *    file with a real key sails through because it was never `git add`ed yet.
 * So: default = what a push can carry (index + non-ignored new files); `--all` = audit
 * everything on disk, ignored or not.
 *
 * Run: npx tsx tools/test-secret-scan.ts     (spawns a throwaway git repo in a temp dir;
 * your own repo, your global git config and your global gitignore are not touched)
 * Exit code 0 = all pass.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN_JS = path.join(HERE, "secret-scan.js");
const mod = createRequire(import.meta.url)(SCAN_JS) as {
	scan: (root: string, mode: "git" | "all") => { hits: string[]; files: number; mode: string };
	scanText: (rel: string, text: string) => string[];
	forbiddenReason: (rel: string) => string | null;
	publishablePaths: (root: string) => { tracked: string[]; fresh: string[] };
};

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  PASS  ${name}`);
	else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Is any reported hit about this path? (hits are "<rel>:<line> — <label>: <match>") */
function mentions(hits: string[], needle: string): boolean {
	return hits.some((h) => h.includes(needle));
}

function mkRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "humbel-scan-"));
	// Point git's global/system config and core.excludesFile at an empty file so a developer's
	// own ~/.gitconfig, ~/.gitignore_global or CORP config cannot change what this test proves.
	const empty = path.join(dir, "empty-git-config");
	fs.writeFileSync(empty, "");
	const r = spawnSync("git", ["-C", dir, "-c", `core.excludesFile=${empty}`, "init", "-q"], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty },
	});
	if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
	return dir;
}

function gitConfig(dir: string): Record<string, string> {
	const empty = path.join(dir, "empty-git-config");
	return { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty } as Record<string, string>;
}

function write(dir: string, rel: string, text: string): string {
	const p = path.join(dir, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text);
	return p;
}

function gitAdd(dir: string, rel: string): void {
	const r = spawnSync("git", ["-C", dir, "add", "--", rel], { encoding: "utf8", env: gitConfig(dir) });
	if (r.status !== 0) throw new Error(`git add ${rel} failed: ${r.stderr}`);
}

function runCli(dir: string, extra: string[] = []) {
	return spawnSync(process.execPath, [SCAN_JS, dir, ...extra], { encoding: "utf8", env: gitConfig(dir) });
}

// Fixtures are built by concatenation ON PURPOSE. Written as one literal, these strings match
// the very patterns the guard scans, and the pre-push hook would (rightly) abort the push over
// them. Do not "tidy" these into plain literals — the self-scan check below now fails if you do.
const SECRET_PATH = "C:" + "\\Users\\Tobias\\.unsloth\\llama.cpp"; // the shape that tripped the hook
const SECRET_KEY = "sk-" + "ABCDEFGHIJKLMNOP1234567890";
const USER_DIR = "C:" + "/Users/" + "Ada";

(async () => {
	const dir = mkRepo();

	// ── a clean repo that happens to contain private-but-ignored content ──
	write(dir, ".gitignore", ".pi/\n");
	write(dir, "notes/clean.md", "plain prose about the project.\n");
	write(dir, "models.example.json", JSON.stringify({ providers: { local: { apiKey: "your-api-key" } } }, null, 2));
	write(dir, "cfg.json", JSON.stringify({ apiKey: "replace_with_your_api_key" }));
	write(dir, "blob.dat", Buffer.concat([Buffer.from("C:\\Users\\Someone text"), Buffer.from([0]), Buffer.from("more")]));
	write(dir, ".pi/PLAN.md", `build with ${SECRET_PATH} and quantize ${SECRET_PATH}\\build\\bin\n`);
	gitAdd(dir, ".gitignore");
	gitAdd(dir, "notes/clean.md");
	gitAdd(dir, "models.example.json");
	gitAdd(dir, "cfg.json");
	gitAdd(dir, "blob.dat");

	const clean = mod.scan(dir, "git");
	check("clean repo passes in push-scope mode", clean.hits.length === 0, clean.hits.join(" | "));
	check("a gitignored file holding a real path is NOT flagged (the false positive that blocked every push)",
		!mentions(clean.hits, "PLAN.md"), clean.hits.join(" | "));
	check("models.example.json is tolerated (only the real name is forbidden)",
		!mentions(clean.hits, "models.example.json"), clean.hits.join(" | "));
	check("placeholder apiKey values are tolerated", !mentions(clean.hits, "cfg.json"), clean.hits.join(" | "));
	check("binary (NUL) files are skipped", !mentions(clean.hits, "blob.dat"), clean.hits.join(" | "));
	check("tracked files are in push scope", clean.files >= 5, `files=${clean.files}`);

	// ── --all still audits the ignored file ──
	const audit = mod.scan(dir, "all");
	check("--all does flag the gitignored file", mentions(audit.hits, ".pi/PLAN.md"), audit.hits.join(" | "));
	check("--all reports the Windows user path", mentions(audit.hits, "Windows user path"), audit.hits.join(" | "));
	check("--all scans more files than push-scope mode", audit.files > clean.files, `${audit.files} vs ${clean.files}`);

	// ── what a push COULD carry must be caught, committed or not ──
	write(dir, "scratch.md", `todo: rotate ${SECRET_KEY} later\n`); // untracked, not ignored
	const fresh = mod.scan(dir, "git");
	check("untracked-but-not-ignored file with an sk- key IS flagged",
		mentions(fresh.hits, "scratch.md") && mentions(fresh.hits, "sk-… key"), fresh.hits.join(" | "));

	write(dir, "tracked-secret.md", `apiKey: "${SECRET_KEY}"\n`);
	gitAdd(dir, "tracked-secret.md"); // committed-adjacent: in the index
	const indexed = mod.scan(dir, "git");
	check("a staged (index) file with a key IS flagged",
		mentions(indexed.hits, "tracked-secret.md"), indexed.hits.join(" | "));

	// ── forbidden names / runtime-data directories ──
	write(dir, "models.json", JSON.stringify({ providers: { local: { apiKey: "your-api-key" } } }));
	check("forbidden filename is flagged by name alone",
		mentions(mod.scan(dir, "git").hits, "forbidden file (models.json)"));
	write(dir, "sessions/state.json", "{}\n");
	check("runtime-data directory is flagged from the file path",
		mentions(mod.scan(dir, "git").hits, "forbidden directory (sessions/)"));
	check("forbiddenReason is path-component based, not just basename",
		mod.forbiddenReason(path.join("a", "plans", "x.md")) === "forbidden directory (plans/)",
		String(mod.forbiddenReason(path.join("a", "plans", "x.md"))));

	// ── a real apiKey value, and the shape the hook actually trips on ──
	write(dir, "cfg2.json", JSON.stringify({ apiKey: "hunter2supersecretnonplaceholder" }));
	check("non-placeholder apiKey value is flagged",
		mentions(mod.scan(dir, "git").hits, "non-placeholder apiKey value"));
	check("scanText catches the Windows user path with forward slashes too",
		mod.scanText("a.md", `open ${USER_DIR}/thing`).length === 1,
		mod.scanText("a.md", `open ${USER_DIR}/thing`).join(" | "));
	check("scanText does not invent a hit for clean text", mod.scanText("a.md", "nothing to see").length === 0);

	// HA long-lived tokens (and any other JWT) are the shape a "pasted it into the docs" leak takes.
	const JWT = "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + "." + "eyJoaWQiOiJ0b2JpYXMifQ" + "." + "sig_Zm9vYmFyYmF6MTIzNDU2Nzg5MA";
	check("a JWT (Home Assistant long-lived token shape) is flagged",
		mod.scanText("profile.ps1", `$env:HUMBLE_PI_HA_TOKEN = "${JWT}"`).some((h: string) => h.includes("JWT token")),
		mod.scanText("profile.ps1", `$env:HUMBLE_PI_HA_TOKEN = "${JWT}"`).join(" | "));
	check("short eyJ-prefixed words are not JWTs (no noise on base64-ish text)",
		mod.scanText("a.md", "eyJ short eyJhbGciOiJub3RhbG9uZy5leUp").length === 0,
		mod.scanText("a.md", "eyJ short eyJhbGciOiJub3RhbG9uZy5leUp").join(" | "));
	write(dir, "profile.ps1", `$env:HUMBLE_PI_HA_TOKEN = "${JWT}"\n`);
	check("a committed PowerShell profile with a token aborts the push",
		mentions(mod.scan(dir, "git").hits, "JWT token"), mod.scan(dir, "git").hits.join(" | ").slice(0, 200));

	// ── the guard's own test file must stay free of literal look-alike secrets ──
	const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
	check("this test file's own source is clean (fixtures are concatenated, not literal)",
		mod.scanText("tools/test-secret-scan.ts", selfSrc).length === 0,
		mod.scanText("tools/test-secret-scan.ts", selfSrc).join(" | ").slice(0, 200));

	// ── node_modules is never publishable content, even untracked ──
	write(dir, "node_modules/pkg/index.js", `const k="${SECRET_KEY}";\n`);
	const withDeps = mod.scan(dir, "git");
	check("node_modules is skipped even when it is not gitignored",
		!mentions(withDeps.hits, "node_modules"), withDeps.hits.join(" | "));

	// ── paths must be relative to the ROOT (a recursive walk that used the sub-dir as base
	//    looked perfectly clean while reporting nothing under .pi/) ──
	const { tracked, fresh: freshPaths } = mod.publishablePaths(dir);
	check("publishable paths are relative to the repo root, nested included",
		tracked.includes("notes/clean.md") && tracked.includes("cfg.json"), JSON.stringify(tracked));
	check("new-but-not-ignored files are reported relative to the root too",
		freshPaths.includes("scratch.md") && freshPaths.includes("models.json"), JSON.stringify(freshPaths));

	// ── the hook's own exit codes ──
	const leaky = runCli(dir);
	check("hook mode exits non-zero when a leak is in push scope", leaky.status === 1, `status=${leaky.status}`);
	check("failure output names the mode it scanned", /push-scope/.test(leaky.stderr), leaky.stderr.slice(0, 120));

	const tidy = mkRepo();
	write(tidy, ".gitignore", ".pi/\n");
	write(tidy, "readme.md", "clean project notes\n");
	write(tidy, ".pi/PLAN.md", `${SECRET_PATH} only here, and it is ignored\n`);
	const ok = runCli(tidy);
	check("clean repo exits 0 from the command line", ok.status === 0, `${ok.status} ${ok.stderr.slice(0, 120)}`);
	check("clean output says what scope was scanned", /push-scope/.test(ok.stdout), ok.stdout.slice(0, 140));
	check("the ignored leak is only reported when you ask for --all",
		runCli(tidy, ["--all"]).status === 1);

	// ── outside a git repo it must not silently scan nothing ──
	const loose = fs.mkdtempSync(path.join(os.tmpdir(), "humbel-nogit-"));
	write(loose, "notes.txt", `${SECRET_KEY} in a loose directory\n`);
	const fallback = runCli(loose);
	check("no git repository -> falls back to the whole-tree audit", fallback.status === 1
		&& /not a git repository/.test(fallback.stderr + fallback.stdout), `status=${fallback.status}`);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
})();
