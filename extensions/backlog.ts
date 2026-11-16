/**
 * backlog — lightweight per-project idea backlog.
 *
 * A plain markdown file at <project>/.pi/backlog.md where the user can jot down
 * ideas even while the agent is working. Items are numbered and timestamped,
 * with checkbox status markers: [ ] open, [~] working (auto-set by the Plan /
 * Implement actions), [x] done.
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
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
// #1: session state lives in the shared module (single writer, fresh RMW saves).
// Importing ./guards only evaluates its top-level constants/functions — the default
// export factory is NOT invoked, so nothing gets registered twice.
import { loadSessionState, loadGuardState, updateSessionState } from "./lib/session-state";
// #13: via the dependency-free lib module — importing ./guards here would drag
// the whole extension graph (typebox, pi-coding-agent) into test runs.
import { defaultPlanFile } from "./lib/plan-file";
// #16: the console plan document (pure module, same rule as plan-file: no pi, no fs).
import { type PlanDoc, type PlanStyle } from "./lib/plan-doc";
// #9: planning mode is a state machine (ON / PAUSED / OFF) owned by guards.ts; the backlog
// row follows the SAME transition table so the two entry points cannot disagree about what
// "plan these" means in a paused session. Title/footer markers come from the same helpers.
import {
  applyPlanTransition,
  bindConsolePlanForStart,
  consolePlanOf,
  consolePlanningRulesText,
  finishPlanReminder,
  planFlagOf,
  planLabel,
  planRetiredOf,
  planStyleForNewPlan,
  planStyleOf,
  planTitleMarker,
  planTransition,
  planningResumeText,
  planningRulesText,
} from "./lib/plan-state";

type Marker = " " | "~" | "x";
interface Entry { num: number; marker: Marker; text: string; }

const ENTRY_RE = /^- \[( |~|x)\] (\d+)\. /;

// #4: plan state is PER SESSION (see ./lib/session-state) — consoles on the same
// machine are independent; this only ever touches the current session's file.
// (#11: no guard-state.json probe — that file is absent on fresh machines even
// though guards works fine with defaults, so it was a false-negative install check.)

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
  return m === "x" ? "done" : m === "~" ? "working" : "open";
}

const USAGE = `📋 Backlog usage:
  /backlog <idea>      add an item
  /backlog             checklist → select items (plan-console / plan-file / implement / done / delete)
                         ← collapse / → expand item (e toggles) · bottom rows: clear completed · clear all`;

// ── Checklist component (shown via ctx.ui.custom) ───────────────────────

export type ChecklistResult = number[] | undefined | "clear-done" | "clear-all";

// Exported for tools/test-backlog-scroll.ts (scrolling/height-budget tests).
export function createChecklist(
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
        // #11: Enter with nothing selected picks the hovered item — no more silent confirm.
        const pick = selected.size > 0 ? [...selected] : [items[cursor].num];
        done(pick.sort((a, b) => a - b));
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
      // Static header lines must be truncated too — pi's renderer throws
      // (and the TUI crashes) when ANY line exceeds the terminal width.
      const lines: string[] = [
        theme.fg("dim", truncateToWidth(`📋 Backlog — ${items.length} item(s) · select one or more`, width)),
        theme.fg("dim", truncateToWidth(
          "↑↓/jk move · x/space select · ← collapse / → expand (e toggles) · ⏎ confirm (or pick hovered item) · esc cancel",
          width,
        )),
      ];

      // Height budget: the dialog must always fit the terminal, or the bottom
      // action rows scroll off-screen on long backlogs. Fixed rows = 2 header +
      // 1 separator + ACTION_ROWS; reserve 2 more for the "more above/below"
      // indicators. Re-read rows each render so live resizes are respected.
      const termRows = (typeof process !== "undefined" && process.stdout?.rows) || 24;
      const fixedRows = 3 + ACTION_ROWS.length;
      const listBudget = Math.max(3, termRows - fixedRows - 2);

      // Row span of each item at this width (expanded items wrap to several).
      const prefixPlain = (i: number): string =>
        `${" "} [${selected.has(items[i].num) ? "x" : " "}] #${items[i].num} ${
          items[i].marker === "x" ? "✓" : items[i].marker === "~" ? "◐" : "○"} `;
      const spans = items.map((it, i) =>
        expanded.has(it.num)
          ? wrapTextWithAnsi(it.text, Math.max(10, width - visibleWidth(prefixPlain(i)))).length
          : 1,
      );

      // Cursor-anchored window: grow backwards then forwards from the hovered
      // item while the budget holds. No scroll keys — ↑/jk already walk the full
      // list; the view follows. (Cursor on an action row anchors at the last item.)
      const anchor = Math.min(cursor, items.length - 1);
      let start = anchor;
      let used = Math.min(spans[anchor], listBudget);
      for (let i = anchor - 1; i >= 0 && used + spans[i] <= listBudget; i--) { used += spans[i]; start = i; }
      let end = anchor;
      for (let i = anchor + 1; i < items.length && used + spans[i] <= listBudget; i++) { used += spans[i]; end = i; }

      for (let i = start; i <= end; i++) {
        const it = items[i];
        const box = selected.has(it.num) ? "x" : " ";
        // Status glyph + color per state, placed BEFORE the text so truncation can
        // never cut it off (the old trailing tag got clipped on long items).
        //   ✓ done (green check, dimmed text) · ◐ working (amber) · ○ open (default)
        const glyph = it.marker === "x" ? "✓" : it.marker === "~" ? "◐" : "○";
        const glyphColored =
          it.marker === "x" ? theme.fg("success", glyph)
          : it.marker === "~" ? theme.fg("warning", glyph)
          : glyph; // open → default color
        const colorText = (t: string): string =>
          it.marker === "x" ? theme.fg("dim", t)
          : it.marker === "~" ? theme.fg("warning", t)
          : t; // open → default color
        const prefix = `${i === cursor ? "❯" : " "} [${box}] #${it.num} ${glyphColored} `;
        if (expanded.has(it.num)) {
          // #9: full text, word-wrapped — continuation lines align with the text column.
          // An expanded item taller than the whole budget is clipped to it
          // (← collapses it back).
          const indent = visibleWidth(prefix);
          const wrapped = wrapTextWithAnsi(it.text, Math.max(10, width - indent));
          wrapped.slice(0, listBudget).forEach((w, wi) => {
            const line = wi === 0 ? prefix + colorText(w) : " ".repeat(indent) + colorText(w);
            lines.push(line);
          });
        } else {
          // Truncate the text only — the status glyph sits before it and always survives.
          const text = truncateToWidth(it.text, Math.max(10, width - visibleWidth(prefix)));
          lines.push(prefix + colorText(text));
        }
      }
      if (start > 0) lines.push(theme.fg("dim", `↑ ${start} more above`));
      if (end < items.length - 1) lines.push(theme.fg("dim", `↓ ${items.length - 1 - end} more below`));

      lines.push(theme.fg("dim", "─".repeat(Math.max(4, Math.min(width, 60)))));
      for (let a = 0; a < ACTION_ROWS.length; a++) {
        const row = items.length + a;
        lines.push(theme.fg("dim", `${row === cursor ? "❯" : " "} ${ACTION_ROWS[a].label}`));
      }
      // Belt-and-braces: no line may ever exceed the terminal width, whatever
      // its source (emoji width quirks, future edits). Measure ANSI-aware.
      return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
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
          `Backlog reference — work on these item(s) (already marked working in .pi/backlog.md):\n${lines.join("\n")}\nWhen you finish one, mark it [x] in .pi/backlog.md.`,
          { deliverAs: "followUp" },
        );
      };

      const doPlan = async (nums: number[], forcedStyle?: PlanStyle): Promise<void> => {
        const lines = nums.map(entryRefLine);
        const sid = ctx.sessionManager.getSessionId();
        const ss = loadSessionState(sid);
        const taskList = `Your task: plan these backlog items:\n${lines.join("\n")}\nDraft the plan for them now.`;
        const titleFor = (state: typeof ss): void => {
          const marker = planTitleMarker(state) || "📋 PLAN";
          ctx.ui.setTitle(`${marker} — pi — ${path.basename(ctx.cwd) || "pi"}`);
        };
        // #16: which STYLE this console plans in. The backlog offers BOTH rows explicitly
        // (console plan / plan file), so a forced style from the picked row wins over the machine
        // default (/plan default tui|file). But a plan already BOUND in this console always wins:
        // a console plan cannot be silently re-pinned to a file, or a pinned file to a console plan
        // (same rule planStyleForNewPlan states for /plan on).
        const boundStyle: PlanStyle | undefined =
          (ss.planDoc ?? null) !== null ? "tui" : ss.planFile ? "file" : undefined;
        if (forcedStyle && boundStyle && forcedStyle !== boundStyle) {
          ctx.ui.notify(
            `📋 This console already has a ${boundStyle === "tui" ? "console plan" : "pinned plan file"} — staying with it. /plan exit leaves it first if you want the ${forcedStyle === "tui" ? "console" : "file"} style instead.`,
            "warning",
          );
        }
        const style: PlanStyle = boundStyle ?? forcedStyle ?? planStyleForNewPlan(ss, loadGuardState().planStyleDefault);

        // #9: PAUSED means "the plan is waiting, side work is allowed". Selecting backlog items
        // for planning is an unambiguous request to bring that plan back — resume the SAME plan
        // (file or console document), never start a second one behind the suspended plan (which is
        // what the old if (!ss.planMode) branch did, because a paused session reads as planMode:false).
        if (planFlagOf(ss) === "paused") {
          if (!planTransition(ss, "resume").ok) {
            ctx.ui.notify("📋 Planning mode is paused but no plan is bound — run /plan on instead.", "warning");
            return;
          }
          const saved = updateSessionState(sid, s => { applyPlanTransition(s, "resume"); });
          titleFor(saved);
          if (planStyleOf(saved) === "tui") {
            ctx.ui.notify(`📋 Console planning RESUMED — ${planLabel(saved)} is back under the write guard. /plan view to edit it.`, "info");
            pi.sendUserMessage(`${consolePlanningRulesText(consolePlanOf(saved), { resumed: true })} Your task: plan these backlog items:\n${lines.join("\n")}\nRevise the plan for them now. ${finishPlanReminder()}`, { deliverAs: "followUp" });
          } else {
            const f = saved.planFile ?? "the plan file";
            ctx.ui.notify(`📋 Planning mode RESUMED — only ${f} may be written while planning is on.`, "info");
            pi.sendUserMessage(`${planningResumeText(f)} Your task: plan these backlog items:\n${lines.join("\n")}\nRevise the plan for them now. ${finishPlanReminder()}`, { deliverAs: "followUp" });
          }
          if (!loadSessionState(sid).planMode) {
            ctx.ui.notify("⚠️ Planning mode did NOT resume — the session-state file still says OFF. Check ~/.pi/agent/session-state/ for other writers.", "warning");
          }
          return;
        }

        let justTurnedOn = false;
        // #22: the retirement note has to reach the ONE mode message below (an info notify is a single
        // status slot — a second notify in the same tick is never seen), so it is built where it is known.
        let retiredBacklogNote = "";
        // #22: the finished plan this start archived, if any — reported after the write lands.
        // A holder object: TypeScript narrows a `let x: T | null = null` that is only assigned inside a
        // callback back to `null` when the callback has run.
        const retiredBacklog: { doc: PlanDoc | null } = { doc: null };
        if (!ss.planMode) {
          // #1: fresh read-modify-write — never save a snapshot taken before the check above.
          const saved = updateSessionState(sid, s => {
            // #22: the SAME bind rule /plan on uses (bindConsolePlanForStart) — keep a draft that is
            // still in progress, retire a FINISHED checklist to planDocPrevious and bind a fresh one to
            // these items. Bound before the transition, so a paused session keeps what it suspended.
            if (style === "tui") {
              s.planStyle = "tui";
              const bound = bindConsolePlanForStart(s, {
                title: `Backlog: ${lines[0] ?? "items"}`.slice(0, 80),
                task: `Plan these backlog items: ${lines.join("; ")}`,
              });
              s.planDoc = bound.doc;
              if (bound.retired) {
                s.planDocPrevious = bound.retired;
                retiredBacklog.doc = bound.retired;
              }
              s.planFile = null; // no pin: console mode blocks EVERY write on purpose
            } else if (!s.planFile) {
              s.planFile = defaultPlanFile(ctx.cwd);
              fs.mkdirSync(path.dirname(s.planFile), { recursive: true });
              s.planStyle = "file";
            }
            applyPlanTransition(s, "on");
          });
          ss.planFile = saved.planFile; // the messages below quote what is actually bound
          ss.planDoc = saved.planDoc;
          titleFor(saved);
          justTurnedOn = true;
          // #22: the retirement fact goes where it cannot be swallowed — the transcript message the model
          // is about to act on (see the longer note in guards.ts for why a status line is not reliable here).
          retiredBacklogNote = retiredBacklog.doc
            ? ` 🗂 The plan previously planned in this console ("${retiredBacklog.doc.title || "untitled"}") has been RETIRED so this one starts fresh — it is archived, not this plan: /plan view last reads it, /plan export last saves it.`
            : "";
          // #11: belt-and-braces after flipping planning mode ON — re-read and warn
          // loudly if it didn't land (mirror of verifyPlanModeOff in guards.ts).
          if (!loadSessionState(sid).planMode) {
            ctx.ui.notify("⚠️ Planning mode did NOT turn on — the session-state file still says OFF. Check ~/.pi/agent/session-state/ for other writers.", "warning");
          }
        } else {
          titleFor(ss); // keep the title in sync with the marker helpers (🌙/🔥 combination)
        }
        if (justTurnedOn && style === "tui") {
          ctx.ui.notify(`📋 CONSOLE plan mode ON from the backlog — the plan is a live document in the TUI (panel above the editor), not a file. /plan view edits it; /plan approve implements it.${retiredBacklogNote}`, "info");
          pi.sendUserMessage(
            `${retiredBacklogNote}${consolePlanningRulesText(consolePlanOf(loadSessionState(sid)))} ${taskList} ${finishPlanReminder()}`,
            { deliverAs: "followUp" },
          );
        } else if (justTurnedOn) {
          pi.sendUserMessage(
            `${planningRulesText(ss.planFile ?? "unbound")} ${taskList} ${finishPlanReminder()}`,
            { deliverAs: "followUp" },
          );
        } else if (style === "tui") {
          pi.sendUserMessage(`We are already in console planning mode (${planLabel(ss)} — build on it with plan_doc, don't restart it). ${taskList}`, { deliverAs: "followUp" });
        } else {
          pi.sendUserMessage(`We are already in planning mode (pinned plan: ${ss.planFile ?? "unbound"}). ${taskList}`, { deliverAs: "followUp" });
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
          ["📝 Plan these — console plan (live in the TUI)", "📝 Plan these — plan file (.pi/PLAN.md)", "⚡ Implement these now", "✅ Mark done", "🗑️ Delete"],
        );
        if (!action) return;

        // options carry emoji prefixes — match on the keyword, not the prefix
        if (action.includes("Plan")) {
          // #9: in a PAUSED session this row RESUMES the pinned plan (see doPlan). Pausing and
          // exiting live in /plan and in the finish_plan approval dialog — this row keeps meaning
          // "start/keep planning", because it is the reflex answer for "these items, please plan".
          // #16: the row picked here also picks the STYLE for a plan that does not exist yet;
          // a bound plan keeps its style no matter which of the two rows was used.
          const forced: PlanStyle = action.includes("console") ? "tui" : "file";
          const mark = setMarkers(file, selected, "~");
          if (mark.changed > 0) ctx.ui.notify(`🔧 Marked ${mark.changed} item(s) working`, "info");
          await doPlan(selected, forced);
        } else if (action.includes("Implement")) {
          const mark = setMarkers(file, selected, "~");
          if (mark.changed > 0) ctx.ui.notify(`🔧 Marked ${mark.changed} item(s) working`, "info");
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
