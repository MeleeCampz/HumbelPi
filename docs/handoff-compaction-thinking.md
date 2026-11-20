# Handoff: compaction at high thinking + local-only model config

Written for a session started **on the host** (outside the sandbox). The extension
and tests are already in the repo; the sandbox's own `~/.pi/agent` was already
patched. What is still outstanding is the **host** config, listed under
[Do this on the host](#do-this-on-the-host).

## The bug, one line

At `thinking: high`, pi's compaction summary is generated with the same thinking
level as normal turns, the model spends the whole response ceiling on reasoning,
the summary arrives truncated, and pi refuses to persist it —
`Summarization failed: generation hit the token cap and the summary is incomplete`.
On the llama.cpp-style server the level also never arrives, because pi's old
`compat` sends thinking as top-level fields that llama.cpp ignores.

## Proof (measured, pi's own `compact()`, your `:8890` server, identical input)

| models.json compat | level | what pi actually sent | result |
|---|---|---|---|
| old (`thinkingFormat:"qwen"`) | `high` | `enable_thinking:true`, `reasoning_effort:"high"`, no budget | **failed** — token cap, incomplete summary |
| old | `off` | `enable_thinking:false` at top level — llama.cpp **ignores it** | **failed** — same message |
| stamped chat-template | `high` | `chat_template_kwargs {enable_thinking:true}` + `thinking_budget_tokens:176` | failed — 1200 max_tokens − 1024 reserved = nothing usable |
| stamped chat-template | **`off`** | `chat_template_kwargs {enable_thinking:false}` | **succeeded** — 2000-char summary, 19.7 s |

So the fix has two halves, and **both are required**: the level must actually
reach the server (`chat_template_kwargs`), and for a summary no thinking budget
works — the level has to go to `off`.

## Already in the repo

| file | what it does |
|---|---|
| `extensions/compaction-thinking.ts` | lowers the thinking level on `session_before_compact`, restores it on `session_compact` / `session_compact_failed`, `agent_end` net. Hands off if you change the level mid-summary; writes nothing when the level already matches; never touches the global default level. `/compact-think [level\|keep\|status]`, `HUMBEL_PI_COMPACT_THINKING` (default `off`) |
| `extensions/lib/compact-think.ts` | the pure half: level bookkeeping, pi's clamping, `llamaCppCompat` shape with the measured probe log |
| `tools/test-compaction-thinking.ts` | 57 checks, drives the extension through a fake pi mirroring pi's real hook ordering — `npx tsx tools/test-compaction-thinking.ts` |
| `tools/sbx-local-model.sh` | **changed**: the sandbox default now *mirrors the host* `defaultProvider`/`defaultModel` (verified to answer from inside the VM); the old probe order is the fallback, and it says so when it falls back |
| `tools/sbx-model-hygiene.sh` | **new**: purges non-local providers from the host `models.json`, validates the host default survived, then re-points every sandbox at that default |

Already applied to **this sandbox's** config (not the host's): all 11 local reasoning models — 4
`unsloth-studio` + 7 strata — carry the chat-template compat (backup `models.json.bak-20261120`,
re-validated against pi's `ModelsConfigSchema` after the stamp), and `settings.json` has
`thinkingBudgets` = 512 / 1536 / 3072 / 6144. `models.json` is read at startup, so a running session
needs a restart (or a fresh `sbxpi` launch) to see it. The sandbox's *default* model is still
`unsloth-studio/...NVFP4_50-Q4K_M` from launch time, while this session was moved to a strata model
with `/model` — running the hygiene script on the host is what makes the two agree from then on.

## Do this on the host

1. **Look first** (changes nothing):

   ```bash
   tools/sbx-model-hygiene.sh --dry-run --stamp-compat
   ```

2. **Apply** — purges every non-local provider (openrouter / anthropic / openai /
   groq / gateway URLs, and any model whose per-model `baseUrl` points off-host),
   stamps the chat-template thinking shape into every local reasoning model, then
   re-points all sandboxes (`sbx ls`) at the host's selection:

   ```bash
   tools/sbx-model-hygiene.sh --stamp-compat
   # --sandbox NAME (repeatable) for one sandbox; --no-sandboxes for the file only
   ```

   It writes `models.json.bak-<timestamp>` first and preserves every other key.
   The stamp only *sets* the thinking knobs — a hand-written `compat` is kept
   (`maxTokensField`, existing `chatTemplateKwargs` entries are not overwritten).

3. **If it prints `host default ... IS GONE`**, the host default was a remote
   model: pick one of the local models it lists, put it in
   `%USERPROFILE%\.pi\agent\settings.json` as `defaultProvider` / `defaultModel`,
   and re-run. Do not skip this — a dangling default makes every session die on
   the first message.

4. **Thinking budgets** into the same `settings.json` (pi's built-in `high` budget,
   16384, *is* your models' whole `maxTokens`):

   ```json
   "thinkingBudgets": { "minimal": 512, "low": 1536, "medium": 3072, "high": 6144 }
   ```

5. **Restart pi** (`models.json` is read at startup). In an already-running
   session `/reload` picks up the new extension. Then `/compact-think` — it should
   report `target: off` and the level it is holding, if any.

## Verify

```bash
npx tsx tools/test-compaction-thinking.ts     # ALL PASS (57 checks)
npx tsc -p tools/tsconfig.check.json --noEmit # clean (after tools/mklink.bat)
/compact-think                                # target + current hold state
```

End-to-end: hold a session at `high`, talk until auto-compaction fires, and check
the transcript — the summary runs at the lowered level, the level is restored
afterwards, and no `Summarization failed` line appears.

## Gotchas

- **The sandbox `models.json` is a snapshot** that `sbxpi` rewrites every launch
  from the host file. That is why hygiene edits the **host** file and then
  re-provisions sandboxes — a hand-edit inside a VM dies with the VM.
  (Fixed 2026-11-20: the rewrite used an unquoted heredoc, so the VM expanded
  the stamped `"$var"` key to `""` and pi rejected the whole file — no local
  providers in the sandbox, claude-only model list, session models erroring.
  The heredoc delimiter is now escaped, `<<\EOF`.)
- **Claude models listed inside a sandbox are credential noise, not capability.**
  Older sandboxes were created with the pi-kit's Anthropic binding accepted, so
  the key is injected and pi lists 18 claude models. The local network policies
  deny `api.anthropic.com` / `platform.claude.com` (curl from a VM: 403), so
  they cannot answer; `sbxpi` now declines the binding at create. Removing the
  binding from existing sandboxes would require re-creating them.
- **Knob compatibility** (measured): `:8888` Unsloth Studio honours top-level
  `enable_thinking` *and* `chat_template_kwargs.enable_thinking`, ignores
  `thinking_budget*`. `:8890` llama.cpp honours `chat_template_kwargs.enable_thinking`
  *and* top-level `thinking_budget_tokens`, ignores top-level `enable_thinking`
  and `chat_template_kwargs.thinking_budget`. The thinking **level** is the only
  knob both servers obey, which is why the compaction target is `off` and not a
  smaller budget.
- **Don't hand-edit a sandbox's `settings.json`** default model: the launch
  script (and `sbx-model-hygiene.sh`) rewrites `defaultProvider` / `defaultModel`.
- **Do not** set `HUMBEL_PI_COMPACT_THINKING=keep` unless you also shrink
  `maxTokens` or grow the context: `keep` means the summary keeps thinking at the
  session level, which is the failing case in the table above.
