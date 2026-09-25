/**
 * Guards Extension (merged: path sandbox + git push guard)
 *
 * Two guards, one state file (~/.pi/agent/guard-state.json), one command.
 *
 * 1. Path sandbox   — tool calls touching paths outside the current project
 *                      (ctx.cwd) ask first. Bash commands are heuristically
 *                      scanned for absolute / escaping paths.
 *                      Two grant tiers:
 *                        • allowedPaths   — full access, never asks (read + write)
 *                        • readOnlyPaths  — reads pass silently; writes/edits/
 *                          deletes still ask. Ambiguous bash is treated as a
 *                          write (conservative).
 * 2. Push guard     — `git push` landing on a protected branch (main/master)
 *                      asks first. Feature branches pass silently.
 *
 * Dialogs follow one format: title names guard + action (e.g. "🛡️ Sandbox —
 * write outside the project"), body is labeled lines (Tool / Target(s) / Project
 * or Branches / Command), options are self-explaining:
 *   "Allow once" | "Always allow … (saved)" | "Read-only here …" (write prompts)
 *   | "No — block". "Always allow" persists to the state file (path prefix
 * allowlist / branch allowlist). Non-interactive modes block unless already allowed.
 *
 * Management via /guards:
 *   /guards                        status overview
 *   /guards toggle sandbox|push    enable/disable a whole guard
 *   /guards allow-path <path>      add to full-access allowlist
 *   /guards revoke-path <path>     remove from full-access allowlist
 *   /guards allow-ro-path <path>   add read-only grant (reads free, writes ask)
 *   /guards revoke-ro-path <path>  remove read-only grant
 *   /guards allow-branch <name>    stop asking for this branch
 *   /guards revoke-branch <name>   start asking again
 *   /guards reset                  clear all grants, re-enable both guards
 *
 * 3. Planning mode — /plan on [task] | off | approve [file] | implement <file> | reject [reason]
 *    Only the pinned plan file may be written (default: ~/.pi/agent/plans/<project>/PLAN.md,
 *    outside the repo). finish_plan presents the finished plan for approval; approve or
 *    implement starts implementation with step-by-step progress reporting.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "guard-state.json");
const PROTECTED_BRANCHES = new Set(["main", "master"]);

interface GuardState {
	sandboxEnabled: boolean;
	pushGuardEnabled: boolean;
	yoloMode: boolean;
	planMode: boolean;
	planFile: string | null;
	planSessionId: string | null;
	allowedPaths: string[];
	readOnlyPaths: string[];
	allowedBranches: string[];
}

const DEFAULT_STATE: GuardState = {
	sandboxEnabled: true,
	pushGuardEnabled: true,
	yoloMode: false,
	planMode: false,
	planFile: null,
	planSessionId: null,
	allowedPaths: [],
	readOnlyPaths: [],
	allowedBranches: [],
};

let stateCache: { mtimeMs: number; data: GuardState } | null = null;

/**
 * Load guard state, cached by file mtime. The footer renders many times per
 * second and every tool_call loads state — the mtime check makes repeated
 * loads a single cheap statSync instead of readFileSync + JSON.parse.
 */
function loadState(): GuardState {
	try {
		const st = fs.statSync(STATE_FILE);
		if (stateCache && st.mtimeMs === stateCache.mtimeMs) return stateCache.data;
		const s = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
		if (!Array.isArray(s.readOnlyPaths)) s.readOnlyPaths = [];
		stateCache = { mtimeMs: st.mtimeMs, data: s };
		return s;
	} catch {
		return { ...DEFAULT_STATE, allowedPaths: [], readOnlyPaths: [], allowedBranches: [] };
	}
}

function saveState(s: GuardState): void {
	fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
	fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
	stateCache = null; // force re-read on next load
}

// ── shell tokenization (quote/escape aware) ─────────────────────
// Reference approach: character-by-character scanning as done by
// shlex / the shell-quote package — never regex over the raw string.

/** Remove heredoc bodies so their content is never scanned as paths. */
function stripHeredocs(command: string): string {
	return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?(?:^|\n)\s*\2\s*(?:\n|$)/g, " ");
}

/**
 * Split a shell command into tokens, respecting single/double quotes and
 * backslash escapes. Quote characters are dropped; ; | & ( ) become their
 * own tokens. Not a full shell parser — precise enough for path/write
 * heuristics without any external dependency.
 */
function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = null;
			else cur += c;
		} else if (quote === '"') {
			if (c === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) {
				cur += command[i + 1];
				i++;
			} else if (c === '"') quote = null;
			else cur += c;
		} else if (c === "'" || c === '"') {
			quote = c;
		} else if (c === "\\" && i + 1 < command.length) {
			const next = command[i + 1];
			if (" ;&|<>()\"'`$*?[]#~=%\n\t".includes(next)) {
				cur += next; // escaped shell special: keep the char, drop the backslash
				i++;
			} else {
				cur += c; // literal backslash (Windows path segments stay intact)
			}
		} else if (/\s/.test(c)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
		} else if ("();|&".includes(c)) {
			if (c === "&" && cur.endsWith(">")) {
				cur += c; // fd dup like 2>&1 stays one token
			} else {
				if (cur) {
					tokens.push(cur);
					cur = "";
				}
				tokens.push(c);
			}
		} else {
			cur += c;
		}
	}
	if (cur) tokens.push(cur);
	return tokens;
}

// ── path helpers ────────────────────────────────────────────────

function resolveProjectPath(raw: string, cwd: string): string {
	const p = raw.replace(/^~(?=[/\\])/, os.homedir());
	return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

function isOutside(target: string, root: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" ? false : rel.startsWith("..") || path.isAbsolute(rel);
}

function pathAllowed(target: string, allowed: string[]): boolean {
	const t = target.toLowerCase().replace(/\\/g, "/");
	return allowed.some((a) => {
		const root = a.toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
		return t === root || t.startsWith(root + "/");
	});
}

/** True when grant g fully covers target t (same path or an ancestor of it). */
function grantCovers(g: string, t: string): boolean {
	const n = (x: string) => x.toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
	const gg = n(g);
	return n(t) === gg || n(t).startsWith(gg + "/");
}

/** #7: current setting of a gated target — "ro" when covered by a read-only grant, else "none". */
export function describeSetting(target: string, state: GuardState): "ro" | "none" {
	return pathAllowed(target, state.readOnlyPaths) ? "ro" : "none";
}

/** #7: group gated targets by existing setting — ro first (conflict with an explicit setting). */
export function groupGated(gated: string[], state: GuardState): { kind: "ro" | "none"; paths: string[] }[] {
	const groups: { kind: "ro" | "none"; paths: string[] }[] = [];
	for (const s of gated) {
		const kind = describeSetting(s, state);
		let g = groups.find((x) => x.kind === kind);
		if (!g) { g = { kind, paths: [] }; groups.push(g); }
		g.paths.push(s);
	}
	groups.sort((a, b) => (a.kind === "ro" ? 0 : 1) - (b.kind === "ro" ? 0 : 1));
	return groups;
}

const SYSTEM_ROOTS = /^\/(dev|proc|sys|bin|usr|etc|var|tmp|opt|lib)([\\/]|$)/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Extract the filesystem path a shell token refers to, resolved against cwd.
 * Returns null when the token is not (or cannot be) a concrete path:
 * URLs, unexpanded variables, bare options, relative paths, ...
 */
function tokenPath(tok: string, cwd: string): string | null {
	let t = tok;
	if (t.startsWith("-")) {
		const eq = t.indexOf("=");
		if (eq < 0) return null; // bare option flag
		t = t.slice(eq + 1); // --file=C:/x → C:/x
	} else if (t.includes("=")) {
		t = t.slice(t.indexOf("=") + 1); // env assignment FOO=/abs/path
	}
	if (!t || URL_SCHEME.test(t)) return null;
	if (t.includes("$")) return null; // variable expansion — cannot resolve
	if (/^[A-Za-z]:[\\/]/.test(t)) return resolveProjectPath(t, cwd); // C:/… or C:\…
	if (/^~[/\\]/.test(t)) return resolveProjectPath(t.replace(/^~/, os.homedir()), cwd);
	if (t.startsWith("/")) {
		if (SYSTEM_ROOTS.test(t)) return null; // /tmp, /usr, … — harmless system dirs
		const m = t.match(/^\/([A-Za-z])([\\/].+)$/);
		if (m) return resolveProjectPath(m[1].toUpperCase() + ":/" + m[2].slice(1), cwd); // Git Bash /c/Users/… → C:/Users/…
		return resolveProjectPath(t, cwd);
	}
	return null; // relative — stays in the project unless it contains .. (caller checks)
}

/** Heuristic: find paths referenced by a shell command that leave the project. */
export function suspiciousPathsInCommand(command: string, cwd: string): string[] {
	const tokens = shellTokens(stripHeredocs(command));
	const outside = new Set<string>();
	for (const tok of tokens) {
		if ("();|&".includes(tok)) continue;
		if (/^(\.\.[\\/]|\/?\.*\.{2,})/.test(tok) || tok.includes("/../") || tok.includes("\\..\\")) {
			outside.add("../…");
			continue;
		}
		const p = tokenPath(tok, cwd);
		if (p !== null && isOutside(p, cwd)) outside.add(p);
	}
	return [...outside];
}

/** Conservative heuristic: does this shell command WRITE anywhere? */
const WRITE_VERBS = new Set(["rm", "mv", "cp", "mkdir", "rmdir", "touch", "tee", "dd", "ln", "install", "chmod", "chown"]);
const GIT_WRITE_SUBS = new Set(["commit", "push", "checkout", "reset", "clean", "rebase", "merge", "amend", "switch", "restore"]);

export function commandWrites(command: string): boolean {
	const tokens = shellTokens(stripHeredocs(command));

	// Redirections (tokens are already unquoted). Dups (2>&1) and /dev/null
	// targets are no-ops; everything else that writes a stream is a write.
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t.includes(">")) continue;
		const redir = t.match(/^(?:\d)?(>>?)(.*)$/);
		if (!redir) continue; // ">" appears mid-word, not a redirection
		const target = redir[2] || (tokens[i + 1] ?? ""); // standalone >: target is next token
		if (target === "") return true;
		if (target === "/dev/null" || target.startsWith("&")) continue; // no-op
		return true;
	}

	// Mutating verbs: first command word of each ; | & segment.
	const segments: string[][] = [[]];
	for (const t of tokens) {
		if (";|&".includes(t)) segments.push([]);
		else segments[segments.length - 1].push(t);
	}
	for (const seg of segments) {
		let i = 0;
		while (i < seg.length && /^[A-Za-z_]\w*=/.test(seg[i])) i++; // env assignments
		if (["sudo", "nohup", "time", "exec", "command", "env"].includes(seg[i] ?? "")) i++;
		const verb = path.posix.basename(seg[i] ?? "").toLowerCase();
		if (!verb) continue;
		if (WRITE_VERBS.has(verb)) return true;
		if (verb === "sed" && seg.slice(i + 1).some((a) => /^-\w*i\w*$/.test(a))) return true; // sed -i
		if (verb === "git") {
			let j = i + 1;
			while (j < seg.length && seg[j].startsWith("-")) j++;
			if (GIT_WRITE_SUBS.has(seg[j] ?? "")) return true; // git commit/push/… only as subcommand
		}
	}
	return false;
}

/** Normalized path comparison (case + separator insensitive). */
function samePath(a: string, b: string): boolean {
	const n = (x: string) => x.toLowerCase().split(String.fromCharCode(92)).join("/").replace(/\/+$/, "");
	return n(a) === n(b);
}

/**
 * Redirection targets of a command, or null when the command contains a
 * verb-based write (rm/cp/sed -i/git commit/…) whose targets cannot be
 * verified. Only call for commands commandWrites() already flagged.
 */
export function bashWriteTargets(command: string): string[] | null {
	const tokens = shellTokens(stripHeredocs(command));

	// Any mutating verb makes the targets undecidable.
	const segments: string[][] = [[]];
	for (const t of tokens) {
		if (";|&".includes(t)) segments.push([]);
		else segments[segments.length - 1].push(t);
	}
	for (const seg of segments) {
		let i = 0;
		while (i < seg.length && /^[A-Za-z_]\w*=/.test(seg[i])) i++; // env assignments
		if (["sudo", "nohup", "time", "exec", "command", "env"].includes(seg[i] ?? "")) i++;
		const verb = path.posix.basename(seg[i] ?? "").toLowerCase();
		if (!verb) continue;
		if (WRITE_VERBS.has(verb)) return null;
		if (verb === "sed" && seg.slice(i + 1).some((a) => /^-\w*i\w*$/.test(a))) return null; // sed -i
		if (verb === "git") {
			let j = i + 1;
			while (j < seg.length && seg[j].startsWith("-")) j++;
			if (GIT_WRITE_SUBS.has(seg[j] ?? "")) return null;
		}
	}

	// Collect redirection targets (same rules as commandWrites).
	const targets: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t.includes(">")) continue;
		const redir = t.match(/^(?:\d)?(>>?)(.*)$/);
		if (!redir) continue; // ">" appears mid-word, not a redirection
		const target = redir[2] || (tokens[i + 1] ?? "");
		if (target === "") return null; // standalone > with no target — undecidable
		if (target === "/dev/null" || target.startsWith("&")) continue; // no-op
		targets.push(target);
	}
	return targets;
}

function sanitizeProjectName(name: string): string {
	return name.replace(/[^\w.-]/g, "_") || "project";
}

/** Plans live outside the repo so git status stays clean. */
function defaultPlanFile(cwd: string): string {
	return path.join(os.homedir(), ".pi", "agent", "plans", sanitizeProjectName(path.basename(cwd)), "PLAN.md");
}

/** Shared implementation instruction (used by /plan approve, /plan implement and finish_plan). */
function implementationInstruction(file: string): string {
	return `PLAN APPROVED. The plan at ${file} is accepted. Implement it now, using the plan as your detailed guideline: follow its steps in order, honor its decisions and constraints, and only deviate when something is genuinely impossible (then say why first). Report progress as you go — one short line per completed step (e.g., "✅ Step 2 done: …"). Start with step 1.`;
}

// ── git push helpers ────────────────────────────────────────────

/** Async git — never blocks the TUI event loop (execSync did). */
function git(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd }, (err, out) => resolve(err ? null : out.toString().trim()));
	});
}

async function pushTargets(cwd: string, rawArgs: string): Promise<string[]> {
	const remotes = new Set(((await git(cwd, ["remote"])) ?? "").split("\n").filter(Boolean));
	const args = rawArgs.split(/\s+/).filter((a) => a && !a.startsWith("-"));
	const targets: string[] = [];
	for (const a of args) {
		if (remotes.has(a)) continue;
		if (a.includes(":")) {
			const dst = a.split(":")[1];
			const branch = dst.replace(/^refs\/(heads\/)?/, "").replace(/\/$/, "");
			if (branch) targets.push(branch);
		} else if (!targets.length && !a.includes("..")) {
			targets.push(a.replace(/^refs\/heads\//, ""));
		}
	}
	if (targets.length === 0) {
		const cur = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		if (cur && cur !== "HEAD") targets.push(cur);
	}
	return targets;
}

// ── extension ───────────────────────────────────────────────────

type Decision = "once" | "always" | "ro" | "block";

/** Terminal window/tab title: guard marker always visible, no console line needed. */
function applyTitle(ctx: ExtensionContext, state: GuardState): void {
	const dir = path.basename(ctx.cwd) || "pi";
	// #12: 🛡️ shown in the normal state; yolo + plan combine instead of hiding each other.
	const marker = [state.yoloMode ? "🔥 YOLO" : null, state.planMode ? "📋 PLAN" : null].filter(Boolean).join(" · ");
	ctx.ui.setTitle(marker ? `${marker} — pi — ${dir}` : `🛡️ pi — ${dir}`);
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Custom footer replacing pi's built-in: identical two lines (pwd+branch,
 * token stats + model), but the pwd line carries a live guard marker —
 * 🛡️ normally, 🔥 while yolo-mode is on. State is re-read every render so
 * toggles appear instantly without re-registering.
 */
function createGuardFooter(ctx: any): (tui: any, theme: any, footerData: any) => any {
	return (_tui: any, theme: any, footerData: any) => ({
		dispose() {},
		render(width: number): string[] {
			const state = loadState();
			const marker = state.yoloMode ? "🔥" : state.planMode ? "📋" : "🛡️";

			// --- line 1: marker + pwd (+ branch, session name) ---
			let cwd = ctx.sessionManager.getCwd();
			const BS = String.fromCharCode(92);
			const home = os.homedir().split(BS).join("/");
			const norm = cwd.split(BS).join("/");
			if (norm === home || norm.startsWith(home + "/")) {
				const rel = norm.slice(home.length).replace(/^\//, "");
				cwd = rel ? `~/${rel}` : "~";
			}
			let pwd = `${marker} ${cwd}`;
			const branch = footerData?.getGitBranch?.();
			if (branch) pwd += ` (${branch})`;
			const sessionName = ctx.sessionManager.getSessionName?.();
			if (sessionName) pwd += ` • ${sessionName}`;
			const pwdLine = theme.fg("dim", truncateToWidth(pwd, width, "..."));

			// --- line 2: usage totals + context % … model on the right ---
			const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			for (const entry of ctx.sessionManager.getEntries()) {
				let usage: any;
				if (entry.type === "usage") usage = entry.usage;
				else if (entry.type === "message" && entry.message?.role === "assistant") usage = entry.message.usage;
				else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.usage) usage = entry.message.usage;
				else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) usage = entry.usage;
				if (!usage) continue;
				totals.input += usage.input ?? 0;
				totals.output += usage.output ?? 0;
				totals.cacheRead += usage.cacheRead ?? 0;
				totals.cacheWrite += usage.cacheWrite ?? 0;
				totals.cost += usage.cost?.total ?? 0;
			}
			const parts: string[] = [];
			if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
			if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
			if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
			if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
			if (totals.cost > 0) parts.push(`$${totals.cost.toFixed(3)}`);
			// perf-stats extension publishes per-call timing here (see perf-stats.ts)
			const perf = footerData?.getExtensionStatuses?.().get("perf");
			if (perf) parts.push(perf);
			const cu = ctx.getContextUsage?.();
			const window = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const pct = cu && cu.percent != null ? `${cu.percent.toFixed(1)}%` : "?";
			parts.push(`${pct}/${formatTokens(window)}`);
			const statsLeft = parts.join(" ");

			let right = ctx.model?.id ?? "no-model";
			if (ctx.model?.reasoning) {
				const lvl = ctx.thinkingLevel || "off";
				right = lvl === "off" ? `${right} • thinking off` : `${right} • ${lvl}`;
			}

			const lw = visibleWidth(statsLeft);
			const rw = visibleWidth(right);
			let statsLine: string;
			if (lw + 2 + rw <= width) {
				statsLine = statsLeft + " ".repeat(width - lw - rw) + right;
			} else if (width - lw > 2) {
				statsLine = statsLeft + " ".repeat(width - lw - 2) + truncateToWidth(right, width - lw - 2, "");
			} else {
				statsLine = truncateToWidth(statsLeft, width, "...");
			}

			return [pwdLine, theme.fg("dim", statsLine)];
		},
	});
}

// #14: freshest ctx for the title self-heal timer (set on session_start / session_info_changed)
let lastCtx: ExtensionContext | null = null;

export default function (pi: ExtensionAPI) {
	async function ask(
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
		title: string,
		body: string,
		options: string[],
	): Promise<Decision> {
		if (!ctx.hasUI) return "block";
		const choice = await ctx.ui.select(`${title}\n\n${body}`, options);
		if (choice === "Allow once") return "once";
		if (typeof choice === "string" && choice.startsWith("Always allow")) return "always";
		// #15: read prompts offer an explicit full-access option with different wording
		if (typeof choice === "string" && choice.startsWith("Full access")) return "always";
		if (typeof choice === "string" && choice.startsWith("Read-only")) return "ro";
		return "block";
	}

	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx;
		const state = loadState();
		// Plans are per-session: a fresh session must not continue an old plan.
		if (state.planMode && state.planSessionId && state.planSessionId !== ctx.sessionManager.getSessionId()) {
			state.planFile = null;
			state.planSessionId = null;
			saveState(state);
			ctx.ui.notify("📋 Planning mode is still on, but the previous session’s plan was not carried over (plans are per-session). Give me a task and I’ll write a fresh plan.", "info");
		}
		applyTitle(ctx, state);
		ctx.ui.setFooter(createGuardFooter(ctx));
	});

	// #14: pi overwrites the terminal title at startup (Windows npm check), agent bind,
	// extension reset and session rename — re-apply our marker every 5 s so it stays in sync.
	const titleTimer = setInterval(() => {
		if (!lastCtx) return;
		try { applyTitle(lastCtx, loadState()); } catch { /* non-interactive mode */ }
	}, 5000);
	titleTimer.unref?.();

	pi.on("session_info_changed", (_e, ctx) => {
		lastCtx = ctx;
		applyTitle(ctx, loadState());
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const state = loadState();
		const cwd = ctx.cwd;

		// ── 0. planning mode: only the pinned plan file may be written ──
		if (state.planMode) {
			const planFile = state.planFile;
			if (event.toolName === "write" || event.toolName === "edit") {
				const p = typeof event.input?.path === "string" ? path.resolve(cwd, event.input.path) : "";
				if (!planFile || !samePath(p, planFile)) {
					return { block: true, reason: `Planning mode: only the pinned plan file may be written${planFile ? ` (${planFile})` : " — none bound, run /plan on"}. Refused: ${event.toolName} → ${p || "?"}. /plan approve to start implementing.` };
				}
			} else if (event.toolName === "bash") {
				const command = (event.input.command as string) ?? "";
				if (commandWrites(command)) {
					const targets = bashWriteTargets(command);
					const ok = !!planFile && targets !== null && targets.length > 0 &&
						targets.every((t) => samePath(path.resolve(cwd, t), planFile));
					if (!ok) {
						return { block: true, reason: "Planning mode: bash may only write the pinned plan file (e.g. echo >> PLAN.md). Verb-based writes are always blocked. /plan approve to start implementing." };
					}
				}
			}
		}
		// ── 1. path sandbox ──
		if (state.sandboxEnabled && !state.yoloMode) {
			let suspects: string[] = [];
			let isWrite = false;
			// The pinned plan file is already vetted by the planning gate — never prompt for it.
			const planExempt = state.planMode ? state.planFile : null;
			if (event.toolName === "bash") {
				const command = (event.input.command as string) ?? "";
				suspects = suspiciousPathsInCommand(command, cwd);
				if (planExempt) suspects = suspects.filter((s) => !samePath(s, planExempt));
				isWrite = commandWrites(command);
			} else if ("path" in event.input && typeof event.input.path === "string") {
				const target = resolveProjectPath(event.input.path, cwd);
				if (isOutside(target, cwd) && !(planExempt && samePath(target, planExempt))) suspects = [target];
				isWrite = event.toolName === "write" || event.toolName === "edit";
			}
			// Full grants always pass. Read-only grants pass only for reads.
			const gated = suspects.filter(
			(s) => !pathAllowed(s, state.allowedPaths) && (isWrite || !pathAllowed(s, state.readOnlyPaths)),
			);
			if (gated.length > 0) {
				const label = `${event.toolName} → ${gated.join(", ")}`;
				// #7: one tailored question per group of targets sharing the same existing setting
				for (const group of groupGated(gated, state)) {
					const savable = group.paths.filter((s) => s !== "../…");
					const title = group.kind === "ro"
						? "🛡️ Sandbox — write into a READ-ONLY area"
						: isWrite
							? "🛡️ Sandbox — write outside the project"
							: "🛡️ Sandbox — read outside the project";
					const options = group.kind === "ro"
						? savable.length > 0
								? ["Allow this write once", "Upgrade to full access (saved)", "Keep read-only — block this write"]
								: ["Allow this write once", "Keep read-only — block this write"]
						: isWrite
							? savable.length > 0
									? ["Allow once", "Always allow here (full access, saved)", "Read-only here (writes still ask, saved)", "No — block"]
									: ["Allow once", "No — block"]
							// #14/#15: reads offer a saved read-only grant; full access must be chosen explicitly
							: savable.length > 0
								? ["Allow once", "Read-only here (writes still ask, saved)", "Full access here (read + write, saved)", "No — block"]
								: ["Allow once", "No — block"];
					const tag = group.kind === "ro" ? "read-only — writes ask" : "no grant";
					const targetLines = group.paths.length === 1
						? [`Target:   ${group.paths[0]}  (${tag})`]
						: [`${group.kind === "ro" ? "Targets (currently read-only):" : "Targets (no existing grant):"}`, ...group.paths.map((s) => `  - ${s}`)];
					const consequence = group.kind === "ro"
						? savable.length > 0 ? `"Upgrade to full access" saves full access for every target above.` : ""
						: isWrite && savable.length > 0
							? `This is a WRITE — "read-only here" will keep asking for writes.`
							// #15: make the weight of a full-access grant from a READ prompt explicit
							: !isWrite && savable.length > 0
								? `"Full access here" also allows writes without asking — pick "Read-only here" if reads are all you need.`
								: "";
					const body = [`Tool:     ${event.toolName}`, ...targetLines, `Project:  ${cwd}`, consequence]
						.filter((l) => l !== "")
						.join("\n");
					let decision: "once" | "always" | "ro" | "block";
					if (group.kind === "ro") {
						// RO group has its own option set — map it locally
						const choice = ctx.hasUI ? await ctx.ui.select(`${title}\n\n${body}`, options) : undefined;
						decision = choice === "Allow this write once" ? "once"
							: typeof choice === "string" && choice.startsWith("Upgrade to full access") ? "always"
							: "block";
					} else {
						decision = await ask(ctx, title, body, options);
					}
					if (decision === "block") return { block: true, reason: `Blocked by user: ${label} (${group.paths.join(", ")})` };
					if (decision === "always" || decision === "ro") {
						if (decision === "always") {
							for (const s of savable) if (!state.allowedPaths.includes(s)) state.allowedPaths.push(s);
							// upgrade: drop read-only grants now covered by a full grant
							state.readOnlyPaths = state.readOnlyPaths.filter((r) => !state.allowedPaths.some((a) => grantCovers(a, r)));
							ctx.ui.notify(group.kind === "ro"
								? `Upgraded to full access (was read-only): ${savable.join(", ")}`
								: isWrite
									? `Always allowed (full access): ${savable.join(", ")}`
									: `Full access granted (reads AND writes): ${savable.join(", ")}`, "info");
						} else {
							for (const s of savable) if (!state.readOnlyPaths.includes(s)) state.readOnlyPaths.push(s);
							ctx.ui.notify(`Read-only granted: ${savable.join(", ")} (reads free, writes still ask)`, "info");
						}
						saveState(state);
					}
				}
			}
		}

		// ── 2. git push guard ──
		if (state.pushGuardEnabled && event.toolName === "bash") {
			const command = (event.input.command as string) ?? "";
			if (/\bgit\s+push\b/.test(command)) {
				const flagged: string[] = [];
				for (const m of command.matchAll(/\bgit\s+push\b/g)) {
					const segment = command.slice(m.index + m[0].length).split(/&&|\|\||;|\|/)[0] ?? "";
					for (const t of await pushTargets(cwd, segment)) {
						if (PROTECTED_BRANCHES.has(t) && !state.allowedBranches.includes(t) && !flagged.includes(t)) {
							flagged.push(t);
						}
					}
				}
				if (flagged.length > 0) {
					const label = `git push → ${flagged.join(", ")}`;
					const body = `Branches: ${flagged.join(", ")}\nCommand:  ${command}`;
					const decision = await ask(
						ctx,
						"🔒 Push to protected branch",
						body,
						["Allow once", "Always allow these branches (saved)", "No — block"],
					);
					if (decision === "block") return { block: true, reason: `Blocked by user: ${label}` };
					if (decision === "always") {
						for (const b of flagged) if (!state.allowedBranches.includes(b)) state.allowedBranches.push(b);
						saveState(state);
						ctx.ui.notify(`Always allowed push to: ${flagged.join(", ")}`, "info");
					}
				}
			}
		}

		return undefined;
	});

	// ── planning mode: one-line frame on every user message (full rules live in the /plan on injection) ──
	pi.on("input", async (event, _ctx) => {
		if (event.source === "extension" || event.text.startsWith("/")) return { action: "continue" };
		const state = loadState();
		if (!state.planMode) return { action: "continue" };
		const file = state.planFile ?? "(no plan file bound — run /plan on)";
		return {
			action: "transform",
			text: `[PLAN MODE] Planning mode is on. Refine the plan at ${file} only; do not implement anything else. /plan approve to finish.\n\nUser message:\n${event.text}`,
		};
	});

	// ── /plan command ──
	pi.registerCommand("plan", {
		description: "Planning mode: /plan on [task] | off | approve [file] | implement <file> | reject [reason]",
		handler: async (args, ctx) => {
			const state = loadState();
			const [cmd, ...rest] = (args ?? "").trim().split(/\s+/);
			const target = rest.join(" ");

			switch (cmd) {
				case undefined:
				case "":
				case "status":
					ctx.ui.notify(
						state.planMode
							? `📋 Planning mode ON — plan file: ${state.planFile ?? "(unbound)"}. finish_plan or /plan approve to implement, /plan reject [reason] to revise.`
							: "Planning mode OFF. Start with: /plan on [task]",
						"info",
					);
					break;

				case "on": {
					if (state.planMode) {
						if (target) {
							ctx.ui.notify("Already in planning mode — sending your task.", "info");
							pi.sendUserMessage(target, { deliverAs: "followUp" });
						} else {
							ctx.ui.notify("Already in planning mode.", "info");
						}
						break;
					}
					const sid = ctx.sessionManager.getSessionId();
					if (!state.planFile || state.planSessionId !== sid) {
						state.planFile = defaultPlanFile(ctx.cwd);
						fs.mkdirSync(path.dirname(state.planFile), { recursive: true });
						state.planSessionId = sid;
					}
					state.planMode = true;
					saveState(state);
					applyTitle(ctx, state);
					ctx.ui.notify(`📋 Planning mode ON — plan file: ${state.planFile}. Reads and web search stay free; all other writes are blocked.`, "info");
					pi.sendUserMessage(
						target
							? `Planning mode is now ACTIVE. Rules: do not implement anything; the only file you may create or modify is ${state.planFile} — write the complete plan there, replacing any stale content. Reading, web search and read-only commands are allowed. When you hit a real decision or ambiguity (architecture choice, trade-off, scope question), use the ask_user tool with concrete options instead of deciding silently — I want to make those calls. Your task: ${target} — draft the plan for it now. When the plan is complete, call the finish_plan tool with a short summary to present it for approval — don't just tell me it's done.`
							: `Planning mode is now ACTIVE. Rules: do not implement anything; the only file you may create or modify is ${state.planFile} — write the complete plan there, replacing any stale content. Reading, web search and read-only commands are allowed. When you hit a real decision or ambiguity (architecture choice, trade-off, scope question), use the ask_user tool with concrete options instead of deciding silently — I want to make those calls. Wait for my task, then draft the plan. When the plan is complete, call the finish_plan tool with a short summary to present it for approval — don't just tell me it's done.`,
						{ deliverAs: "followUp" },
					);
					break;
				}

				case "off":
					state.planMode = false;
					saveState(state);
					applyTitle(ctx, state);
					ctx.ui.notify("Planning mode OFF — normal operation (implementation allowed).", "info");
					break;

				case "approve": {
					if (!state.planMode) {
						ctx.ui.notify("Not in planning mode. /plan on first.", "warning");
						break;
					}
					const file = target ? path.resolve(ctx.cwd, target) : state.planFile ?? path.join(ctx.cwd, "PLAN.md");
					if (!fs.existsSync(file)) {
						ctx.ui.notify(`Plan file not found: ${file}\nUsage: /plan approve [path/to/plan.md]`, "warning");
						break;
					}
					state.planMode = false;
					state.planFile = null;
					state.planSessionId = null;
					saveState(state);
					applyTitle(ctx, state);
					ctx.ui.notify(`✅ Plan approved — starting implementation of ${file}`, "info");
					pi.sendUserMessage(implementationInstruction(file), { deliverAs: "followUp" });
					break;
				}

				case "reject": {
					if (!state.planMode) {
						ctx.ui.notify("Not in planning mode.", "warning");
						break;
					}
					const file = state.planFile ?? "the plan file";
					const feedback = target.trim();
					ctx.ui.notify(feedback ? `📋 Plan rejected with feedback — still in planning mode.` : `📋 Plan rejected — still in planning mode. Tell me what should change (or /plan off to exit).`, "info");
					pi.sendUserMessage(
						`The plan is REJECTED.${feedback ? `\nUser feedback: ${feedback}` : ""} Do NOT implement anything from it. We are still in planning mode — tell me what should change and I’ll revise ${file}.`,
						{ deliverAs: "followUp" },
					);
					break;
				}

				case "implement": {
					if (!target) {
						ctx.ui.notify("Usage: /plan implement <path/to/plan.md>", "warning");
						break;
					}
					const file = path.resolve(ctx.cwd, target);
					if (!fs.existsSync(file)) {
						ctx.ui.notify(`Plan file not found: ${file}`, "warning");
						break;
					}
					if (state.planMode) {
						state.planMode = false;
						state.planFile = null;
						state.planSessionId = null;
						saveState(state);
						applyTitle(ctx, state);
					}
					ctx.ui.notify(`🚀 Implementing ${file} (planning mode off)`, "info");
					pi.sendUserMessage(implementationInstruction(file), { deliverAs: "followUp" });
					break;
				}

				default:
					ctx.ui.notify("Usage: /plan on [task] | off | approve [file] | implement <file> | reject [reason]", "warning");
			}
		},
	});

	// ── finish_plan tool: model-triggered approval dialog ──
	pi.registerTool({
		name: "finish_plan",
		label: "Finish plan",
		description:
			"Call when the plan document is complete and you want the user to approve it. " +
			"Shows an Approve / Keep-planning dialog; approval starts implementation immediately. " +
			"Do NOT implement anything before approval.",
		promptSnippet:
			"finish_plan(summary) — present the finished plan for approval (approve → implementation starts; otherwise wait for feedback)",
		parameters: Type.Object({
			summary: Type.String({ description: "2-4 sentence summary of the plan, shown in the approval dialog" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = loadState();
			if (!state.planMode) {
				return { content: [{ type: "text", text: "Not in planning mode — run /plan on first. Do not implement." }], details: undefined };
			}
			const file = state.planFile;
			if (!file || !fs.existsSync(file)) {
				return { content: [{ type: "text", text: `Plan file missing (${file ?? "unbound"}) — write the plan there first, then call finish_plan again.` }], details: undefined };
			}
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: `No interactive UI available. Ask the user to run: /plan approve ${file}` }], details: undefined };
			}
			const choice = await ctx.ui.select(`📋 Plan ready — approve?\n\nFile:     ${file}\n\n${params.summary}`, ["✅ Approve & implement", "✏️ Keep planning"]);
			if (choice === undefined || !/approve/i.test(choice)) {
				// #13: refusal reason inline — no extra manual turn
				const reason = choice === undefined ? undefined : await ctx.ui.input("✏️ What should change in the plan?", "e.g. use SQLite instead of JSON, drop step 3…");
				if (reason && reason.trim()) {
					pi.sendUserMessage(
						`The plan is REJECTED.\nUser feedback: ${reason.trim()}\n\nDo NOT implement anything from it. We are still in planning mode — revise ${file} accordingly and call finish_plan again when ready.`,
						{ deliverAs: "followUp" },
					);
					ctx.ui.notify("📋 Feedback queued — revising the plan.", "info");
					return { content: [{ type: "text", text: "Plan rejected with user feedback (queued as your next message). Do NOT implement. End your turn now; when the feedback arrives, revise the plan file and call finish_plan again." }], details: undefined };
				}
				return { content: [{ type: "text", text: "The user wants to keep planning. Do NOT implement. Wait for their feedback, revise the plan file, and call finish_plan again when ready." }], details: undefined };
			}
			state.planMode = false;
			state.planFile = null;
			state.planSessionId = null;
			saveState(state);
			applyTitle(ctx, state);
			ctx.ui.notify(`✅ Plan approved — starting implementation of ${file}`, "info");
			// #10: no queued follow-up — the instruction goes into the tool result so the model
			// implements in the SAME turn. A queued message would land later as a stale duplicate.
			return { content: [{ type: "text", text: implementationInstruction(file) }], details: undefined };
		},
	});

	// ── /guards command ──
	pi.registerCommand("guards", {
		description: "Security guards: status, toggles, path/branch allowlists (see extension header for syntax)",
		handler: async (args, ctx) => {
			const state = loadState();
			const [cmd, ...rest] = (args ?? "").trim().split(/\s+/);
			const target = rest.join(" ");

			const statusText = () =>
				[
					`🛡️ Guards (${STATE_FILE})`,
					`  yolo    : ${state.yoloMode ? "🔥 ON (sandbox silenced)" : "off"}`,
					`  plan    : ${state.planMode ? `📋 ON (${state.planFile ?? "no file bound"})` : "off"}`,
					`  sandbox : ${state.sandboxEnabled ? "ON " : "OFF"}`,
					`  push    : ${state.pushGuardEnabled ? "ON " : "OFF"}`,
					`  allowed paths  : ${state.allowedPaths.length ? state.allowedPaths.join(", ") : "(none)"}`,
					`  read-only paths : ${state.readOnlyPaths.length ? state.readOnlyPaths.join(", ") : "(none)"}`,
					`  allowed branches: ${state.allowedBranches.length ? state.allowedBranches.join(", ") : "(none)"}`,
				].join("\n");

			switch (cmd) {
				case undefined:
				case "":
				case "status":
					ctx.ui.notify(statusText(), "info");
					break;

				case "yolo": {
					const arg = (rest[0] ?? "").toLowerCase();
					state.yoloMode = arg === "on" ? true : arg === "off" ? false : !state.yoloMode;
					saveState(state);
					applyTitle(ctx, state);
					// #12: "info" (replaceable status line) for both directions — a "warning"
					// notification is a permanent chat line that never gets cleared on exit.
					ctx.ui.notify(
						state.yoloMode
							? "🔥 YOLO mode ON — path sandbox silenced (push guard still active). /guards yolo off to exit."
							: "YOLO mode off — guards fully active.",
						"info",
					);
					break;
				}

				case "toggle":
					if (rest[0] === "sandbox") state.sandboxEnabled = !state.sandboxEnabled;
					else if (rest[0] === "push") state.pushGuardEnabled = !state.pushGuardEnabled;
					else {
						ctx.ui.notify("Usage: /guards toggle sandbox|push", "warning");
						return;
					}
					saveState(state);
					ctx.ui.notify(statusText(), "info");
					break;

				case "allow-path": {
					if (!target) {
						ctx.ui.notify("Usage: /guards allow-path <path>", "warning");
						return;
					}
					const abs = resolveProjectPath(target, ctx.cwd);
					if (!state.allowedPaths.includes(abs)) state.allowedPaths.push(abs);
					saveState(state);
					ctx.ui.notify(`Allowed path: ${abs}`, "info");
					break;
				}

				case "revoke-path": {
					const norm = (p: string) => p.toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
					const want = norm(resolveProjectPath(target || "", ctx.cwd));
					const before = state.allowedPaths.length;
					state.allowedPaths = state.allowedPaths.filter((p) => norm(p) !== want);
					if (state.allowedPaths.length === before) {
						ctx.ui.notify(`No allowlist entry matched: ${target}`, "warning");
						return;
					}
					saveState(state);
					ctx.ui.notify(statusText(), "info");
					break;
				}

				case "allow-branch":
					if (!target) {
						ctx.ui.notify("Usage: /guards allow-branch <name>", "warning");
						return;
					}
					if (!state.allowedBranches.includes(target)) state.allowedBranches.push(target);
					saveState(state);
					ctx.ui.notify(`Push to '${target}' no longer requires confirmation.`, "info");
					break;

				case "allow-ro-path": {
					if (!target) {
						ctx.ui.notify("Usage: /guards allow-ro-path <path>", "warning");
						return;
					}
					const abs = resolveProjectPath(target, ctx.cwd);
					if (!state.readOnlyPaths.includes(abs)) state.readOnlyPaths.push(abs);
					saveState(state);
					ctx.ui.notify(`Read-only granted: ${abs} (reads free, writes still ask)`, "info");
					break;
				}

				case "revoke-ro-path": {
					const norm = (p: string) => p.toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
					const want = norm(resolveProjectPath(target || "", ctx.cwd));
					const before = state.readOnlyPaths.length;
					state.readOnlyPaths = state.readOnlyPaths.filter((p) => norm(p) !== want);
					if (state.readOnlyPaths.length === before) {
						ctx.ui.notify(`No read-only entry matched: ${target}`, "warning");
						return;
					}
					saveState(state);
					ctx.ui.notify(statusText(), "info");
					break;
				}

				case "revoke-branch":
					state.allowedBranches = state.allowedBranches.filter((b) => b !== target);
					saveState(state);
					ctx.ui.notify(statusText(), "info");
					break;

				case "reset":
					saveState({ ...DEFAULT_STATE, allowedPaths: [], readOnlyPaths: [], allowedBranches: [] });
					ctx.ui.notify("Guards reset: both ON, all grants cleared.", "info");
					break;

				default:
					ctx.ui.notify(
						[
							"Usage:",
							"  /guards                     status",
							"  /guards toggle sandbox|push",
							"  /guards allow-path <path>    full access grant",
							"  /guards revoke-path <path>",
							"  /guards allow-ro-path <path> read-only grant (writes still ask)",
							"  /guards revoke-ro-path <path>",
							"  /guards allow-branch <name>",
							"  /guards revoke-branch <name>",
							"  /guards reset",
						].join("\n"),
						"info",
					);
			}
		},
	});
}
