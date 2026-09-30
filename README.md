# HumbelPi

Personal [pi coding agent](https://github.com/badlogic/pi-mono) setup, distributed as a
[pi package](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
Everything here is **extensions** — the pi installation itself is never modified.

What you get:

- 🔒 **Guards** — a path sandbox and a git push guard gate risky operations with
  permission dialogs ([file access](#sandbox--file-access-outside-the-project),
  [push guard](#push-guard))
- 🔥 **Yolo mode** — silence the path sandbox for a session; on by default inside
  sandboxes ([yolo mode](#yolo-mode))
- 🌙 **Unattended mode** — `/away [instruction]` keeps the agent working while you're
  away, dialogs auto-reject ([unattended mode](#unattended-mode))
- 📋 **Planning mode** — plan first, approve via dialog, then implement with progress
  reporting ([planning mode](#planning-mode))
- ✅ **Backlog** — a multi-select task checklist with plan/implement/done actions
  ([backlog](#backlog))
- ✍️ **Spellcheck** — live typo highlighting while you type ([spellcheck](#spellcheck))
- 🔎 **Web search**, 💬 **ask_user** dialogs, 📈 **perf stats** in the footer

Two ways to run it: plainly on your machine (install below), or — recommended — inside
a real sandbox with one command: [Real sandbox (sbxpi)](#real-sandbox-docker-sandboxes-sbx).

## Getting started

```bash
# 1. pi itself (pristine, unmodified)
npm i -g @earendil-works/pi-coding-agent

# 2. this package
pi install git:github.com/MeleeCampz/HumbelPi
```

That's it — the extensions load into every pi session on this machine.

## ⚠️ The guards are not a real sandbox

The path sandbox in `guards.ts` is a **heuristic**. It scans bash commands token by
token and checks tool paths against the project root — it is a guardrail against
accidents, **not a security boundary**.

It can be bypassed, intentionally or not:

- shell variables and expansion (`$HOME`, `$(…)`, backticks), encoded or indirect
  commands, and anything that builds a path at runtime;
- creating a brand-new directory tree *outside* the project (nothing exists yet,
  so there is nothing to detect);
- any tool or code path that isn't inspected token-by-token.

**If you work with untrusted content, very capable models, or unattended runs —
run pi inside a proper sandbox:** a microVM (Docker Sandboxes, Firecracker & co.),
a VM, or at least strict OS-level user/permissions. The guards then become a
second layer of convenience on top of a real boundary, not the boundary itself.

Note: **a plain Docker container is NOT a real sandbox** — it only isolates via
namespaces and cgroups on the *shared host kernel*, so a kernel exploit can escape
it. MicroVMs (like Docker Sandboxes) give each sandbox its own kernel; that is what
makes them a real boundary.

This repo ships exactly that: [Real sandbox (Docker Sandboxes / sbx)](#real-sandbox-docker-sandboxes-sbx)
— one command, pi running in a microVM with HumbelPi installed inside.

## Real sandbox (Docker Sandboxes / sbx)

[The guards](#-the-guards-are-not-a-real-sandbox) are a guardrail. For a real
boundary, `tools/sbx-pi.sh` runs pi inside a
[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) **microVM** — one
command from any folder:

```bash
cd /path/to/any/project
sbxpi
```

`sbxpi` is a self-locating shim from the repo's `bin/` directory (setup in
[docs/sbxpi.md](docs/sbxpi.md)) that launches `tools/sbx-pi.sh`, which:

1. Creates a sandbox from Docker's official pi kit (`docker.io/sbx/pi-kit:latest`),
   with `HUMBLE_PI_YOLO=1` baked in so yolo mode is on by default inside (see
   [Yolo mode](#yolo-mode)) — or reuses the existing one for this folder (sandboxes
   are named `pi-<folder>`).
2. Mounts two things into the microVM: your current folder as a **read-write
   workspace**, and this repo **read-only**.
3. Wires your local model: copies the provider from your host's
   `~/.pi/agent/models.json` into the sandbox (baseUrl rewritten to
   `http://host.docker.internal:8888/v1`) and sets it as pi's default model —
   merged into `settings.json`, so installed packages and preferences survive
   re-provisioning. Sandboxes deliberately don't import user-level `~/.pi`
   config, so this step exists.
4. Installs HumbelPi from the read-only mount — guards, backlog, `/away`, perf stats
   and friends run **inside** the VM, as a second layer on top of the real boundary.
5. Drops you into pi's TUI, already on your model — and **continues your last
   session** in that folder (`pi --continue`). With no prior session it simply
   starts fresh; `sbxpi --new` always starts a fresh one.

### Setup & day-to-day

Requirements in short: the standalone [`sbx` CLI](https://docs.docker.com/ai/sandboxes/install/)
(signed in — **no Docker Desktop needed**, sbx ships its own microVM runtime),
bash + Node.js, and `<this repo>\bin` on your PATH so `sbxpi` works in any
terminal on any OS.

Full one-time setup (per OS), the sandbox management commands (`sbx ls / run /
stop / rm / prune`) and sbxpi-specific notes/gotchas live in
[**docs/sbxpi.md**](docs/sbxpi.md) — for how Docker Sandboxes itself works, see
the [official docs](https://docs.docker.com/ai/sandboxes/).

## Sandbox — file access outside the project

![Sandbox file-access dialog](imgs/Guards_FileAccess.png)

- Any tool call touching a path **outside the project** is gated by this dialog before
  it runs.
- The dialog shows: tool name, target(s) with their current setting (`no grant` /
  `read-only — writes ask`), the project root, and a consequence note where relevant.
- Options depend on the request and existing grants:
  - read, no grant: `Allow once` · `Always allow here (saved)` · `No — block`
  - write, no grant: adds `Read-only here (writes still ask, saved)`
  - write into a read-only area: `Allow this write once` · `Upgrade to full access (saved)`
    · `Keep read-only — block this write`
- Saved options persist per machine in `~/.pi/agent/guard-state.json`; "Allow once" is
  one-shot; blocking aborts the tool call immediately.
- Honest limitation: bash commands are scanned *heuristically* for the paths they
  touch — the sandbox is a guardrail, not a hard boundary. See
  [⚠️ The guards are not a real sandbox](#-the-guards-are-not-a-real-sandbox) —
  for real isolation, use the [Docker Sandboxes setup above](#real-sandbox-docker-sandboxes-sbx).

## Push guard

![Git push guard](imgs/GitPushGuard.png)

- `git push` landing on a protected branch (`main` / `master`) is gated by this dialog;
  feature branches pass silently.
- Options: `Allow once` · `Always allow these branches (saved)` · `No — block`. Saved
  branches persist in `~/.pi/agent/guard-state.json`; manage them with
  `/guards allow-branch <name>` / `/guards revoke-branch <name>`.

## Yolo mode

![Yolo mode](imgs/YoloMode.png)

- 🔥 YOLO mode silences the path sandbox — tool calls no longer ask about paths
  outside the project. The **push guard stays active**. Like planning and unattended
  mode, it is **per console**: state lives in `~/.pi/agent/session-state/<session>.json`,
  so other pi consoles on the same machine keep asking.
- **Default ON in `sbxpi` sandboxes**: the `sbxpi` launcher creates every sandbox with
  `HUMBLE_PI_YOLO=1` baked in (`sbx create --env`), and pi starts new sessions with yolo
  mode already on there — in a proper sandbox the container IS the isolation boundary,
  so the path guard would only add noise. Sandboxes without the variable keep the guards
  fully active. A `/guards yolo off` sticks for that session (it's persisted to the
  session-state file).
- The state is visible at all times in the window title (`🔥 YOLO — pi — <dir>`) and
  in the `/guards` status line, so you always know it's on.
- Toggle: `/guards yolo on | off`.

## Unattended mode

- For when you step away and want the agent to keep working: `/away [instruction]`
  turns unattended mode on and immediately hands your instruction to the agent as its
  next message. If a run is already active, the instruction **steers** that run —
  delivered before the agent's next LLM call so it can redirect immediately instead
  of finishing the old task first. Bare `/away` turns it off.
- While on, **every confirmation dialogue is auto-rejected instead of hanging**: the
  sandbox path dialog, the push guard, `ask_user`, and the `finish_plan` approval all
  decline automatically, and each rejection tells the model to pick the safest reasonable
  option and record it in a "Decisions made while unattended" section of its final report.
- Every user message also carries an `[UNATTENDED MODE]` frame so the model knows you are
  away and should not wait for input — when it runs out of safe work it ends its turn
  with a summary instead of blocking.
- **Per console**: unattended state lives in `~/.pi/agent/session-state/<session>.json`,
  so other pi consoles on the same machine are unaffected; resuming the same session
  keeps it, new sessions start clean. YOLO silencing still wins — ops yolo already
  silences never reach a dialog and keep passing silently.
- Visible in the window title (`🌙 AWAY — pi — <dir>`, combines with 🔥/📋), the footer
  marker, and the `/guards` status line.

## Planning mode

![Planning mode](imgs/Planning_Mode.png)

- Enter with `/plan on [task]` — one step: opens planning mode and hands the task
  over as the plan's starting point.
- **Per console**: plan state lives in `~/.pi/agent/session-state/<session>.json`, so
  other pi consoles on the same machine are unaffected; resuming a session keeps its
  plan, new sessions start clean.
- While active, only the plan file is writable: `<project>/.pi/PLAN.md` (in the
  project, gitignored, next to the backlog — easy to access even when pi runs in a
  VM); reads and searches stay free.
- The finished plan is presented via the **finish_plan** dialog — "✅ Approve & implement"
  starts implementation immediately; "✏️ Keep planning" asks for a short refusal reason
  that is fed back to the agent.
- Planning state also syncs into the window title, so it's visible at a glance.

## Backlog

![Backlog checklist](imgs/Backlog.png)

- Bare `/backlog` opens the project's task list (`.pi/backlog.md`) as a multi-select
  checklist; `/backlog <idea>` appends a new item.
- Navigate with ↑↓ / `j` `k`, toggle items with `x` or space, ⏎ confirms the selection,
  esc cancels. Long items expand inline with `e` or → (word-wrapped full text);
  several can be open at once.
- After confirming, pick an action for the selected items: **plan** (hands them to
  planning mode), **implement**, **mark done**, or **delete** — plus bottom rows for
  clearing completed / all entries.
- Status markers per item: `[ ]` open, `[~]` in progress, `[x]` done (rendered dimmed).

## Spellcheck

`spellcheck.ts` replaces pi's editor with a subclass that highlights likely typos
**live, in place, while you type** — red + underlined, like a web form. No prompts,
no post-enter confirmation: the text is sent exactly as typed.

![Spellcheck highlighting](imgs/SpellCheck.png)

- Works **everywhere you type free text**: the main editor, slash-command arguments
  (e.g. `/backlog <idea>`, `/plan reject [reason]`) and the free-text dialogs — the
  `ask_user` “Other” answer and the plan-feedback input (“✏️ Keep planning”).
- Dictionary: `extensions/words-en.txt` (~370k words, bundled); personal additions go
  to `~/.pi/agent/spell-ignore.txt` (one word per line — names, identifiers, project terms).
- Skipped: slash command names, CamelCase / ALLCAPS tokens, words with digits or symbols,
  words ≤ 2 letters.
- Toggle: `/spellcheck on | off | status`.

## Ask user

![Ask user dialog](imgs/SampleQuestion.png)

- The `ask_user` tool lets the agent check in before making an important assumption:
  it presents a list of concrete options plus a free-text "Other" escape hatch. Your
  answer comes back as the tool result and the agent proceeds with exactly that.

## Web search

- Registers a `web_search` tool in every project.
- Backends are tried in order: `BRAVE_API_KEY` (Brave Search API) →
  `TAVILY_API_KEY` (Tavily) → DuckDuckGo HTML (no key required).
- For full page content after a search, the agent just curls the URL.

## Performance stats

![Perf indicator](imgs/PerfIndicator.png)

- Per-LLM-call stats on the footer's model info line — no extra console lines.
- **TTFT**: request → first content delta; **gen tok/s**: output tokens / streaming
  time (live estimate while streaming); **prompt eval**: blended prefill speed, shown
  when possible.
- Measured client-side from pi's events — providers don't report server-side timing.

## What's inside

```
extensions/
  guards.ts        sandbox + git-push guard, yolo mode, unattended mode (/away [instruction]),
                   planning mode (/plan on [task]), per-group permission dialogs,
                   custom footer (perf stats), title sync
  backlog.ts       /backlog checklist: multi-select + actions (plan/implement/done/delete/clear)
  perf-stats.ts    tok/s + TTFT measured client-side, shown in the footer
  working-task.ts  working_task tool — model sets/clears the current task in the working indicator
  spellcheck.ts    spelling checks for user messages (dictionary: extensions/words-en.txt)
  web-search.ts    web search tool
  ask-user.ts      structured ask_user dialog
.githooks/pre-push   secret scan that runs on every push (this repo is public)
bin/
  sbxpi, .ps1, .cmd  PATH launcher shims — `sbxpi` in any terminal/OS
docs/
  sbxpi.md           sbxpi setup (per OS), sandbox management, gotchas
tools/
  sbx-pi.sh          one-command sandbox launcher — see "Real sandbox" above
  sbx-local-model.sh wires a sandbox's pi to the host's local model
```

## Development on a machine that uses this repo directly

Install with a local path instead of git — pi loads the extensions in place, so
editing a file here and restarting pi is the whole dev loop:

```bash
pi install ./path/to/HumbelPi
```

The `pre-push` hook (`.githooks/pre-push`, enabled per clone via
git config core.hooksPath .githooks) runs tools/secret-scan.js on every push:
API keys, non-placeholder apiKey values, PEM private keys, Bearer tokens,
user-specific paths. It aborts the push if anything looks private.

## Troubleshooting

- `pi list` — shows installed packages and where they resolve to.
- `/reload` — reload extensions/settings after manual edits.
- `pi update --extensions` — reconcile package installs (pulls new commits from a git source).
- Grants live in `~/.pi/agent/guard-state.json`. `/guards` shows the full status;
  individual grants are managed with `/guards allow-path|revoke-path|allow-ro-path|
  revoke-ro-path|allow-branch|revoke-branch`, and `/guards reset` clears everything
  and re-enables both guards.
