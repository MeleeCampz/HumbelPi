#!/usr/bin/env bash
# Model-config hygiene for the pi setup: drop every non-local (third-party API)
# provider from the host ~/.pi/agent/models.json, then re-point every sandbox at
# the host's own selection so host and sandbox run the same model.
#
# Run this on the HOST (Git Bash / MSYS), like tools/sbx-local-model.sh:
#   tools/sbx-model-hygiene.sh --dry-run          # show what would go, change nothing
#   tools/sbx-model-hygiene.sh                    # purge host, then refresh all sandboxes
#   tools/sbx-model-hygiene.sh --sandbox NAME     # only that sandbox (repeatable)
#   tools/sbx-model-hygiene.sh --all              # sandboxes from `sbx ls` (default)
#   tools/sbx-model-hygiene.sh --no-sandboxes     # host file only
#
# What counts as local: a baseUrl on localhost / 127.0.0.1 / [::1] (the host's own
# servers: Unsloth Studio :8888, Strata :8889/:8890) or host.docker.internal (the
# same servers seen from inside a sandbox). Anything else — openrouter, anthropic,
# openai, groq, a gateway URL — is removed.
#
# The file is backed up to models.json.bak-<timestamp> before anything is written,
# and everything in models.json except the filtered providers is preserved verbatim.
# A per-model baseUrl override counts too: a model that points at a remote host is
# dropped even from a local provider.
#
# --stamp-compat also writes the measured chat-template thinking shape (see
# docs/handoff-compaction-thinking.md) into every local reasoning model's compat:
# thinkingFormat chat-template + chatTemplateKwargs.enable_thinking + the
# llama.cpp thinking_budget_tokens field. Existing compat keys are kept; only the
# thinking knobs are set, so a hand-written compat is not clobbered silently.
set -euo pipefail
export PATH="/usr/bin:/bin:$PATH"

if command -v sbx >/dev/null 2>&1; then SBX="sbx"
elif [ -n "${LOCALAPPDATA:-}" ] && [ -f "$LOCALAPPDATA/DockerSandboxes/bin/sbx.exe" ]; then SBX="$LOCALAPPDATA/DockerSandboxes/bin/sbx.exe"
else SBX=""; fi
if command -v node >/dev/null 2>&1; then NODE="node"
elif [ -f "/c/Program Files/nodejs/node.exe" ]; then NODE="/c/Program Files/nodejs/node.exe"
else echo "error: node not found (looked in C:\\Program Files\\nodejs too)" >&2; exit 1; fi

DRY=0; ALL=1; STAMP=0; NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --sandbox) [ $# -ge 2 ] || { echo "--sandbox needs a name" >&2; exit 1; }
              NAMES+=("$2"); ALL=0; shift 2 ;;
    --all) ALL=1; shift ;;
    --no-sandboxes) ALL=0; shift ;;
    --stamp-compat) STAMP=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

HOST_MODELS="${USERPROFILE:+$USERPROFILE/.pi/agent/models.json}"
[ -f "${HOST_MODELS:-/nonexistent}" ] || HOST_MODELS="$HOME/.pi/agent/models.json"
[ -f "$HOST_MODELS" ] || { echo "host models.json not found (looked in \$USERPROFILE and \$HOME)" >&2; exit 1; }
HOST_SETTINGS="${USERPROFILE:+$USERPROFILE/.pi/agent/settings.json}"
[ -f "${HOST_SETTINGS:-/nonexistent}" ] || HOST_SETTINGS="$HOME/.pi/agent/settings.json"

echo "== host config: $HOST_MODELS"

# 1. Purge non-local providers/models. Backup first, then one node pass that
# rewrites the file (or only reports, under --dry-run) and prints a KEPT/DROP
# report on stdout - no temp file, because a Windows node.exe and Git Bash do not
# agree on what "/tmp/..." means.
BACKUP_STAMP=$(date +%Y%m%d-%H%M%S)
MODE=write
STAMP_ARG=nostamp
if [ "$DRY" = 1 ]; then MODE=dry; fi
if [ "$STAMP" = 1 ]; then STAMP_ARG=stamp; fi
[ "$DRY" = 1 ] || cp "$HOST_MODELS" "$HOST_MODELS.bak-$BACKUP_STAMP"
REPORT=$("$NODE" -e '
const fs = require("fs");
const f = process.argv[1];
const WRITE = process.argv[2] === "write";
const STAMP_COMPAT = process.argv[3] === "stamp";
const m = JSON.parse(fs.readFileSync(f, "utf8"));
// host.docker.internal counts as local: this filter also runs over a sandbox copy,
// where the very same servers have already been rewritten to that hostname.
const LOCAL = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"];
const host = (u) => { try { return new URL(u || "").hostname; } catch { return ""; } };
const dropped = [];
const out = { ...m, providers: {} };
for (const [name, p] of Object.entries((m && m.providers) || {})) {
  if (!LOCAL.includes(host(p.baseUrl))) { dropped.push(`${name} (${p.baseUrl || "no baseUrl"})`); continue; }
  const models = (p.models || []).filter((mo) => !mo.baseUrl || LOCAL.includes(host(mo.baseUrl)));
  const gone = (p.models || []).length - models.length;
  if (gone) dropped.push(`${name}: ${gone} model(s) with a remote per-model baseUrl`);
  if (!models.length) { dropped.push(`${name} (no local models left)`); continue; }
  out.providers[name] = { ...p, models: models.map((mo) => {
    if (!STAMP_COMPAT || !mo.reasoning) return mo;
    const c = { ...(mo.compat || {}) };
    const was = JSON.stringify(c);
    c.maxTokensField = c.maxTokensField || "max_tokens";
    c.thinkingFormat = "chat-template";
    c.chatTemplateKwargs = { ...(c.chatTemplateKwargs || {}), enable_thinking: (c.chatTemplateKwargs || {}).enable_thinking || { $var: "thinking.enabled" } };
    c.thinkingTokenBudgetField = c.thinkingTokenBudgetField || "thinking_budget_tokens";
    return JSON.stringify(c) === was ? mo : { ...mo, compat: c };
  }) };
}
if (WRITE) fs.writeFileSync(f, JSON.stringify(out, null, 2) + "\n");
console.log("KEPT\t" + (Object.keys(out.providers).join(", ") || "(none)"));
for (const d of dropped) console.log("DROP\t" + d);
if (!dropped.length) console.log("DROP\tnothing - the file was already local-only");
if (STAMP_COMPAT) {
  const n = Object.values(out.providers).flatMap((p) => p.models).filter((mo) => mo.compat && mo.compat.thinkingFormat === "chat-template").length;
  console.log("STAMP\t" + n + " local reasoning model(s) carry the chat-template thinking shape");
}
' "$HOST_MODELS" "$MODE" "$STAMP_ARG") || { echo "purge failed" >&2; exit 1; }

KEPT=""
STAMPED=""
DROPPED=()
while IFS=$'\t' read -r KIND TEXT; do
  case "$KIND" in
    KEPT) KEPT=$TEXT ;;
    DROP) DROPPED+=("$TEXT") ;;
    STAMP) STAMPED=$TEXT ;;
  esac
done <<< "$REPORT"
echo "kept providers:   ${KEPT:-none}"
echo "dropped:"
for d in "${DROPPED[@]}"; do echo "  - $d"; done
if [ -n "$STAMPED" ]; then
  if [ "$DRY" = 1 ]; then echo "would stamp:      $STAMPED"; else echo "stamped:          $STAMPED"; fi
fi
[ "$DRY" = 1 ] || echo "backup:           $HOST_MODELS.bak-$BACKUP_STAMP"
if [ "$DRY" = 1 ]; then
  echo "[dry-run] nothing written. Remove --dry-run to apply."
  exit 0
fi

# 2. The host default must still exist after the purge, or every session dies on it.
HOST_DEFAULTS=$("$NODE" -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`${s.defaultProvider||""}\t${s.defaultModel||""}`)}catch{console.log("\t")}' "$HOST_SETTINGS" 2>/dev/null || printf '\t')
HP=${HOST_DEFAULTS%%$'\t'*}; HM=${HOST_DEFAULTS#*$'\t'}
if [ -n "$HM" ]; then
  if "$NODE" -e '
    const m = require(process.argv[1]);
    const p = (m.providers || {})[process.argv[2]];
    process.exit(p && (p.models || []).some((x) => x.id === process.argv[3]) ? 0 : 1);
  ' "$HOST_MODELS" "$HP" "$HM" 2>/dev/null; then
    echo "host default:     $HP/$HM (still present)"
  else
    echo "host default:     $HP/$HM IS GONE — it was a remote model. Pick a local one:"
  "$NODE" -e 'const m=require(process.argv[1]);for(const[n,p]of Object.entries(m.providers||{}))for(const mo of p.models||[])console.log("  pi --provider "+n+" --model "+mo.id)' "$HOST_MODELS"
    echo "Then set it in $HOST_SETTINGS (defaultProvider / defaultModel) and re-run this script."
    exit 1
  fi
else
  echo "host default:     none set in $HOST_SETTINGS (sandboxes fall back to probe order)"
fi

# 3. Re-point the sandboxes: sbx-local-model.sh copies only local providers and now
# mirrors the host default, so running it per sandbox is the parity fix.
if [ "${#NAMES[@]}" -eq 0 ] && [ "$ALL" = 1 ]; then
  if [ -z "$SBX" ]; then
    echo "[warn] sbx not found — skipping the sandbox pass (pass --sandbox NAME explicitly)"
    exit 0
  fi
  echo "== sandboxes from \`sbx ls\`"
  while read -r line; do
    [ -n "$line" ] || continue
    case "$line" in NAME*|SANDBOX*|*agent*|---*) continue ;; esac
    n=$(cut -d" " -f1 <<<"$line")
    [ -n "$n" ] && NAMES+=("$n")
  done <<<"$("$SBX" ls 2>/dev/null || true)"
fi
if [ "${#NAMES[@]}" -eq 0 ]; then
  echo "[done] no sandboxes to refresh"
  exit 0
fi
for n in "${NAMES[@]}"; do
  echo "== sandbox $n"
  "${BASH_SOURCE[0]%/*}/sbx-local-model.sh" "$n"
done
echo "[done] host and sandboxes now run the same local model selection"
