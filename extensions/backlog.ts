/**
 * backlog — lightweight per-project idea backlog.
 *
 * A plain markdown file at <project>/.pi/backlog.md where the user can jot down
 * ideas even while the agent is working. Items are numbered and timestamped,
 * with checkbox status markers: [ ] open, [~] in progress, [x] done.
 *
 * Commands (exactly two entry points — everything else lives in the checklist UI):
 *   /backlog <idea...>     append a new item (works mid-turn, never interrupts)
 *   /backlog               multi-select checklist:
 *                            select items → action: plan / implement / mark done / delete
 *                            bottom rows: clear completed items · clear all (with confirm)
 *
 * Global extension: applies to every project. No state of its own; the "plan"
 * action writes the shared guard-state.json (schema owner: guards.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Marker = " " | "~" | "x";
interface Entry { num: number; marker: Marker; text: string; }

const ENTRY_RE = /^- \[( |~|x)\] (\d+)\. /;

// ── Shared guard state (schema owner: guards.ts) ────────────────────────
// The "plan" action flips planning mode on, exactly like `/plan on` does.
const GUARD_STATE_FILE = path.join(os.homedir(), ".pi", "agent", "guard-state.json");
interface GuardStateLite { planMode?: boolean; planFile?: string | null; planSessionId?: string | null; [k: string]: unknown; }

function loadGuardState(): GuardStateLite | null {
  try { return JSON.parse(fs.readFileSync(GUARD_STATE_FILE, "utf8")) as GuardStateLite; } catch { return null; }
}
function saveGuardState(gs: GuardStateLite): void { fs.writeFileSync(GUARD_STATE_FILE, JSON.stringify(gs)); }

// Duplicated from guards.ts — keep in sync with sanitizeProjectName/defaultPlanFile there.
function sanitizeProjectName(name: string): string {
  return name.replace(/[^\w.-]/g, "_") || "project";
}
function defaultPlanFile(cwd: string): string {
  return path.join(os.homedir(), ".pi", "agent", "plans", sanitizeProjectName(path.basename(cwd)), "PLAN.md");
}

// ── Backlog file helpers ────────────────────────────────────────────────

function backlogPath(cwd: string): string {
  return path.join(cwd, ".pi", "backlog.md");
}

function headerFor(cwd: string): string {
  const name = path.basename(cwd) || "project";
  return `# Backlog — ${name}`;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readEntries(file: string): Entry[] {
  if (!fs.existsSync(file)) return [];
  const out: Entry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(ENTRY_RE);
    if (!m) continue;
    out.push({ num: parseInt(m[2], 10), marker: m[1] as Marker, text: line.slice(m[0].length).trim() });
  }
  return out;
}

function nextNumber(entries: Entry[]): number {
  return entries.reduce((max, e) => Math.max(max, e.num), 0) + 1;
}

/** Create the file with a header if missing; add a header to headerless files. */
function ensureFile(file: string, cwd: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = headerFor(cwd);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, header + "\n");
    return;
  }
  const content = fs.readFileSync(file, "utf8");
  if (!content.startsWith("# Backlog")) {
    fs.writeFileSync(file, header + "\n" + content);
  }
}

function appendEntry(file: string, text: string, cwd: string): number {
  ensureFile(file, cwd);
  // Defensive: a hand-edited file may lack the trailing newline — never glue items together.
  const existing = fs.readFileSync(file, "utf8");
  if (existing.length > 0 && !existing.endsWith("\n")) fs.appendFileSync(file, "\n");
  const num = nextNumber(readEntries(file));
  fs.appendFileSync(file, `- [ ] ${num}. (${timestamp()}) ${text}\n`);
  return num;
}

/** Set status markers for the given numbers. Returns counts of changed/missing. */
function setMarkers(file: string, nums: number[], marker: Marker): { changed: number; missing: number[] } {
  if (!fs.existsSync(file)) return { changed: 0, missing: [...nums] };
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let changed = 0;
  const found = new Set<number>();
  const out = lines.map((line) => {
    const m = line.match(ENTRY_RE);
    if (!m) return line;
    const num = parseInt(m[2], 10);
    if (!nums.includes(num)) return line;
    found.add(num);
    changed++;
    return `- [${marker}] ${m[2]}. ` + line.slice(m[0].length);
  });
  fs.writeFileSync(file, out.join("\n"));
  return { changed, missing: nums.filter((n) => !found.has(n)) };
}

/** Remove all done items. Returns how many were removed. */
function clearDone(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let removed = 0;
  const out = lines.filter((line) => {
    const m = line.match(ENTRY_RE);
    if (m && m[1] === "x") { removed++; return false; }
    return true;
  });
  fs.writeFileSync(file, out.join("\n"));
  return removed;
}

/** Remove the exact entries for the given numbers. Returns counts of removed/missing. */
function removeEntries(file: string, nums: number[]): { removed: number; missing: number[] } {
  if (!fs.existsSync(file)) return { removed: 0, missing: [...nums] };
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let removed = 0;
  const found = new Set<number>();
  const out = lines.filter((line) => {
    const m = line.match(ENTRY_RE);
    if (m && nums.includes(parseInt(m[2], 10))) {
      found.add(parseInt(m[2], 10));
      removed++;
      return false;
    }
    return true;
  });
  fs.writeFileSync(file, out.join("\n"));
  return { removed, missing: nums.filter((n) => !found.has(n)) };
}

function markerLabel(m: Marker): string {
  return m === "x" ? "done" : m === "~" ? "in progress" : "open";
}

const USAGE = `📋 Backlog usage:
  /backlog <idea>      add an item
  /backlog             checklist → select items (plan / implement / done / delete)
                         ← collapse / → expand item (e toggles) · bottom rows: clear completed · clear all`;

// ── Checklist component (shown via ctx.ui.custom) ───────────────────────

export type ChecklistResult = number[] | undefined | "clear-done" | "clear-all";

function createChecklist(
  items: Entry[],
  theme: { fg(color: string, text: string): string },
  done: (result: ChecklistResult) => void,
) {
  const ACTION_ROWS = [
    { id: "clear-done" as const, label: "✂ Clear completed items" },
    { id: "clear-all" as const, label: "⚠ Clear all items" },
  ];
  const totalRows = items.length + ACTION_ROWS.length;
  let cursor = 0;
  const selected = new Set<number>();
  const expanded = new Set<number>(); // #9: items whose full text is shown word-wrapped

  return {
    handleInput(data: string): void {
      if (matchesKey(data, "escape")) { done(undefined); return; }
      if (matchesKey(data, "enter")) {
        if (cursor >= items.length) { done(ACTION_ROWS[cursor - items.length].id); return; }
        done(selected.size > 0 ? [...selected].sort((a, b) => a - b) : undefined);
        return;
      }
      if (matchesKey(data, "up") || data === "k") { cursor = Math.max(0, cursor - 1); return; }
      if (matchesKey(data, "down") || data === "j") { cursor = Math.min(totalRows - 1, cursor + 1); return; }
      if (data === "e" || matchesKey(data, "left") || matchesKey(data, "right")) {
        const it = items[cursor];
        if (!it) return; // action rows are not expandable
        // #13: ← collapse · → expand · e toggles (as before)
        if (matchesKey(data, "left")) expanded.delete(it.num);
        else if (matchesKey(data, "right")) expanded.add(it.num);
        else if (expanded.has(it.num)) expanded.delete(it.num);
        else expanded.add(it.num);
        return;
      }
      if (data === "x" || data === " ") {
        const it = items[cursor];
        if (!it) return; // action rows are not selectable
        if (selected.has(it.num)) selected.delete(it.num); else selected.add(it.num);
      }
    },

    render(width: number): string[] {
      const lines: string[] = [
        theme.fg("dim", `📋 Backlog — ${items.length} item(s) · select one or more`),
        theme.fg("dim", "↑↓/jk move · x/space select · ← collapse / → expand (e toggles) · ⏎ confirm · esc cancel"),
      ];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const box = selected.has(it.num) ? "x" : " ";
        const tag = it.marker === "x" ? " (done)" : it.marker === "~" ? " (in progress)" : "";
        const prefix = `${i === cursor ? "❯" : " "} [${box}] #${it.num} `;
        if (expanded.has(it.num)) {
          // #9: full text, word-wrapped — continuation lines align with the text column
          const indent = visibleWidth(prefix);
          const wrapped = wrapTextWithAnsi(`${it.text}${tag}`, Math.max(10, width - indent));
          wrapped.forEach((w, wi) => {
            const line = wi === 0 ? prefix + w : " ".repeat(indent) + w;
            lines.push(it.marker === "x" ? theme.fg("dim", line) : line);
          });
        } else {
          const text = truncateToWidth(`${it.text}${tag}`, Math.max(10, width - 12));
          const line = prefix + text;
          lines.push(it.marker === "x" ? theme.fg("dim", line) : line);
        }
      }
      lines.push(theme.fg("dim", "─".repeat(Math.max(4, Math.min(width, 60)))));
      for (let a = 0; a < ACTION_ROWS.length; a++) {
        const row = items.length + a;
        lines.push(theme.fg("dim", `${row === cursor ? "❯" : " "} ${ACTION_ROWS[a].label}`));
      }
      return lines;
    },

    invalidate(): void {},
  };
}

// ── Command ─────────────────────────────────────────────────────────────

interface CmdCtx {
  cwd: string;
  mode?: string;
  sessionManager: { getSessionId(): string };
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
    custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T>;
    setTitle(title: string): void;
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("backlog", {
    description: "Backlog: /backlog <idea> appends an idea; bare /backlog opens the checklist (select items → plan/implement/done/delete; ← collapse / → expand, e toggles; bottom rows clear done/all)",

    async handler(target: string, ctx: CmdCtx) {
      const file = backlogPath(ctx.cwd);
      const spec = (target ?? "").trim();

      const entryRefLine = (n: number): string => {
        const e = readEntries(file).find((x) => x.num === n);
        return e ? `#${e.num} [${markerLabel(e.marker)}] ${e.text}` : `#${n} (no longer exists)`;
      };

      const sendReference = (nums: number[]): void => {
        const lines = nums.map(entryRefLine);
        pi.sendUserMessage(
          `Backlog reference — work on these item(s):\n${lines.join("\n")}\nWhen you start one, mark it [~] in .pi/backlog.md; when finished, mark it [x].`,
          { deliverAs: "followUp" },
        );
      };

      const doPlan = async (nums: number[]): Promise<void> => {
        const lines = nums.map(entryRefLine);
        const gs = loadGuardState();
        if (!gs) {
          pi.sendUserMessage(`Planning mode is not set up on this machine — run /plan on first. Items to plan:\n${lines.join("\n")}`, { deliverAs: "followUp" });
          return;
        }
        let justTurnedOn = false;
        if (!gs.planMode) {
          const sid = ctx.sessionManager.getSessionId();
          if (!gs.planFile || gs.planSessionId !== sid) {
            gs.planFile = defaultPlanFile(ctx.cwd);
            fs.mkdirSync(path.dirname(gs.planFile), { recursive: true });
            gs.planSessionId = sid;
          }
          gs.planMode = true;
          saveGuardState(gs);
          ctx.ui.setTitle(`📋 PLAN — pi — ${path.basename(ctx.cwd) || "pi"}`);
          justTurnedOn = true;
        }
        const taskList = `Your task: plan these backlog items:\n${lines.join("\n")}\nDraft the plan for them now.`;
        if (justTurnedOn) {
          pi.sendUserMessage(
            `Planning mode is now ACTIVE. Rules: do not implement anything; the only file you may create or modify is ${gs.planFile} — write the complete plan there, replacing any stale content. Reading, web search and read-only commands are allowed. When you hit a real decision or ambiguity (architecture choice, trade-off, scope question), use the ask_user tool with concrete options instead of deciding silently — I want to make those calls. ${taskList} When the plan is complete, call the finish_plan tool with a short summary to present it for approval — don't just tell me it's done.`,
            { deliverAs: "followUp" },
          );
        } else {
          pi.sendUserMessage(`We are already in planning mode (pinned plan: ${gs.planFile}). ${taskList}`, { deliverAs: "followUp" });
        }
      };

      const runChecklist = async (): Promise<void> => {
        const entries = readEntries(file);
        if (entries.length === 0) {
          ctx.ui.notify("📋 Backlog empty — add one with /backlog <idea>", "info");
          return;
        }
        if (!ctx.ui.custom || ctx.mode !== "tui") {
          // Non-interactive mode: plain list instead of the dialog.
          pi.sendUserMessage(
            `Backlog items:\n${entries.map((e) => `#${e.num} [${markerLabel(e.marker)}] ${e.text}`).join("\n")}\nOpen the TUI checklist (bare /backlog) to plan, implement, mark done or delete.`,
            { deliverAs: "followUp" },
          );
          return;
        }
        const selected = await ctx.ui.custom<ChecklistResult>(
          (_tui, theme, _kb, done) => createChecklist(entries, theme as { fg(c: string, t: string): string }, done),
        );
        if (selected === "clear-done") {
          const removed = clearDone(file);
          ctx.ui.notify(removed > 0 ? `🧹 Removed ${removed} done item(s)` : "Nothing to remove — no [x] items", "info");
          return;
        }
        if (selected === "clear-all") {
          const count = readEntries(file).length;
          const yes = await ctx.ui.select(
            "🗑️ Clear the whole backlog?",
            [count > 0 ? `Yes, delete all ${count} item(s)` : "Yes, clear it", "No, cancel"],
          );
          if (yes && yes.startsWith("Yes")) {
            fs.writeFileSync(file, headerFor(ctx.cwd) + "\n");
            ctx.ui.notify(`🗑️ Backlog cleared`, "info");
          } else {
            ctx.ui.notify("Backlog: cancelled", "info");
          }
          return;
        }
        if (!selected || selected.length === 0) return; // Esc or empty confirm

        const action = await ctx.ui.select(
          `📋 Action on ${selected.map((n) => `#${n}`).join(", ")}`,
          ["📝 Plan these — enters planning mode", "⚡ Implement these now", "✅ Mark done", "🗑️ Delete"],
        );
        if (!action) return;

        // options carry emoji prefixes — match on the keyword, not the prefix
        if (action.includes("Plan")) {
          await doPlan(selected);
        } else if (action.includes("Implement")) {
          sendReference(selected);
        } else if (action.includes("Mark done")) {
          const { changed, missing } = setMarkers(file, selected, "x");
          if (changed > 0) ctx.ui.notify(`✅ Marked ${changed} item(s) done`, "info");
          if (missing.length > 0) ctx.ui.notify(`Backlog: no such item(s): ${missing.map((n) => `#${n}`).join(", ")}`, "warning");
        } else if (action.includes("Delete")) {
          const { removed, missing } = removeEntries(file, selected);
          if (removed > 0) ctx.ui.notify(`🗑️ Deleted ${removed} backlog item(s)`, "info");
          if (missing.length > 0) ctx.ui.notify(`Backlog: no such item(s): ${missing.map((n) => `#${n}`).join(", ")}`, "warning");
        }
      };

      // ── bare command → checklist; anything else → new idea (capture-first) ──
      if (spec === "") { await runChecklist(); return; }
      const num = appendEntry(file, spec, ctx.cwd);
      ctx.ui.notify(`📋 Backlog #${num} added`, "info");
    },
  });
}
