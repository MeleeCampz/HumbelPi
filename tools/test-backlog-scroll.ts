/**
 * Regression test for the backlog checklist height budget: when the item list
 * is taller than the terminal, the view must scroll (cursor-anchored) and the
 * bottom action rows ("Clear completed" / "Clear all") must ALWAYS stay
 * visible — the whole render must never exceed the terminal height.
 *
 * Run: npx -y tsx tools/test-backlog-scroll.ts   (no deps needed)
 */
import { createChecklist } from "../extensions/backlog";

const theme = { fg: (_c: string, t: string) => t }; // strip styling for assertions
const strip = (s: string) => s.replace(/\u001b[^\n]*?m/g, ""); // safety net if fg ever styles

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

// Fake a small terminal (12 rows) for the whole test.
Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
const ROWS = 12;
const WIDTH = 80;

// 30 items — far more than fit in 12 rows.
const N = 30;
const items = Array.from({ length: N }, (_, i) => ({
  num: i + 1,
  marker: (i % 5 === 0 ? "x" : i % 3 === 0 ? "~" : " ") as " " | "~" | "x",
  text: `backlog item number ${i + 1} with some filler words to make it longer`,
}));

function fresh() {
  let result: unknown;
  const c = createChecklist(items, theme, (r) => { result = r; });
  return { c, getResult: () => result };
}

// ── 1. initial render fits the terminal and shows the action rows at the bottom ──
{
  const { c } = fresh();
  const lines = c.render(WIDTH);
  check("render height ≤ terminal rows", lines.length <= ROWS, `got ${lines.length}`);
  const last2 = [strip(lines[lines.length - 2]), strip(lines[lines.length - 1])];
  check("action row 'Clear completed' visible (second-to-last)", last2[0].includes("Clear completed"), JSON.stringify(last2));
  check("action row 'Clear all' visible (last)", last2[1].includes("Clear all"));
  check("'more below' indicator present", lines.some((l) => strip(l).includes("more below")));
  check("first item visible at top of list", strip(lines[2]).includes("#1 "));
}

// ── 2. moving the cursor down scrolls the view; actions stay put ──
{
  const { c } = fresh();
  for (let i = 0; i < N - 1; i++) c.handleInput("j"); // hover last item
  const lines = c.render(WIDTH);
  check("after scrolling: height ≤ rows", lines.length <= ROWS, `got ${lines.length}`);
  check("after scrolling: 'Clear all' still last line", strip(lines[lines.length - 1]).includes("Clear all"));
  check("after scrolling: last item visible", lines.some((l) => strip(l).includes(`#${N} `)));
  check("after scrolling: first item scrolled away", !lines.some((l) => strip(l).includes("#1 ")));
  check("after scrolling: 'more above' indicator present", lines.some((l) => strip(l).includes("more above")));
  check("after scrolling: no 'more below'", !lines.some((l) => strip(l).includes("more below")));
}

// ── 3. hovering an action row still fits and highlights the action ──
{
  const { c } = fresh();
  for (let i = 0; i < N + 1; i++) c.handleInput("j"); // onto 'Clear all'
  const lines = c.render(WIDTH);
  check("on action row: height ≤ rows", lines.length <= ROWS, `got ${lines.length}`);
  check("on action row: cursor on 'Clear all'", strip(lines[lines.length - 1]).startsWith("❯"));
  // Enter confirms the action
  c.handleInput("\r");
}

// ── 4. an expanded item taller than the budget is clipped, not overflowing ──
{
  const long = [...items];
  long[0] = { num: 1, marker: " ", text: "word ".repeat(200).trim() }; // wraps to ~50 lines at width 80
  let result: unknown;
  const c = createChecklist(long, theme, (r) => { result = r; });
  c.handleInput("\u001b[1;2C"); // → expand item #1 (or 'e')
  if (!c.render(WIDTH).some((l) => strip(l).includes("word word"))) c.handleInput("e"); // fallback: toggle via e
  const lines = c.render(WIDTH);
  check("expanded giant item: height ≤ rows", lines.length <= ROWS, `got ${lines.length}`);
  check("expanded giant item: 'Clear all' still last line", strip(lines[lines.length - 1]).includes("Clear all"));
  c.handleInput("\u001b[1;1D"); // ← collapse (sanity: input stays handled)
}

// ── 5. small backlog (fits naturally) renders everything, no indicators ──
{
  const few = items.slice(0, 3);
  let result: unknown;
  const c = createChecklist(few, theme, (r) => { result = r; });
  const lines = c.render(WIDTH);
  check("small list: all items shown", [1, 2, 3].every((n) => lines.some((l) => strip(l).includes(`#${n} `))));
  check("small list: no scroll indicators", !lines.some((l) => /more (above|below)/.test(strip(l))));
  check("small list: height ≤ rows", lines.length <= ROWS, `got ${lines.length}`);
}

// ── 6. Enter on a hovered item still resolves with its number ──
{
  const few = items.slice(0, 3);
  let result: unknown;
  const c = createChecklist(few, theme, (r) => { result = r; });
  c.handleInput("j"); // hover #2
  c.handleInput("\r");
  check("enter picks hovered item", JSON.stringify(result) === "[2]", `got ${JSON.stringify(result)}`);
}

console.log(failures === 0 ? "\nAll backlog scroll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
