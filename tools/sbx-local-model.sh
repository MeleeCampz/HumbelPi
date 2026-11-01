#!/usr/bin/env bash
# Wire an sbx pi sandbox to the local model (Unsloth Studio, or Strata as fallback).
#
# Each sbx sandbox is a fresh microVM: pi starts with no providers because the
# host's ~/.pi/agent is not imported. This script writes a models.json into the
# sandbox's agent dir, pointing at the host via host.docker.internal (verified
# reachable from inside the microVM; plain localhost/127.0.0.1 are the VM itself).
# Default model: the first locally hosted provider that answers from inside the
# VM, tried in preference order unsloth-studio (:8888) -> any provider named
# strata* (:8890 light profile, :8889 heavy one) -> file order.
#
# Usage: tools/sbx-local-model.sh <sandbox-name> [--install-pi]
#   --install-pi  also run `pi install .` in the sandbox's workspace (if it is a pi package)
#
# Syncs every locally hosted provider from the host models.json (baseUrl host
# rewritten to host.docker.internal, port/path kept) — INCLUDING per-model
# baseUrl overrides, which is how one provider can span two server ports.
# Rewriting only the provider-level baseUrl leaves a model pointing at
# 127.0.0.1, and inside the VM that is the VM itself: "Connection error."
# Default model: the first provider that actually ANSWERS from inside the VM,
# tried in preference order unsloth-studio -> any provider named strata* ->
# file order. A provider that is configured but not running used to become the
# default anyway, and every message then failed.
set -euo pipefail

# bash.exe launched directly from PowerShell inherits a minimal PATH —
# restore Git Bash's own tool dirs (see sbx-pi.sh).
export PATH="/usr/bin:/bin:$PATH"

# The interactive shell's PATH may lack sbx/node — resolve each with common
# install-location fallbacks (Windows), else fail with a clear message.
if command -v sbx >/dev/null 2>&1; then
  SBX="sbx"
elif [ -n "${LOCALAPPDATA:-}" ] && [ -f "$LOCALAPPDATA/DockerSandboxes/bin/sbx.exe" ]; then
  SBX="$LOCALAPPDATA/DockerSandboxes/bin/sbx.exe"
else
  echo "error: sbx not found on PATH (looked in \$LOCALAPPDATA/DockerSandboxes/bin too). Install Docker Sandboxes or add it to PATH." >&2
  exit 1
fi
if command -v node >/dev/null 2>&1; then
  NODE="node"
elif [ -f "/c/Program Files/nodejs/node.exe" ]; then
  NODE="/c/Program Files/nodejs/node.exe"
else
  echo "error: node not found on PATH (looked in C:\\Program Files\\nodejs too). Install Node.js or add it to PATH." >&2
  exit 1
fi

NAME="${1:-}"; shift || true
INSTALL_PI=0
for a in "$@"; do
  case "$a" in
    --install-pi) INSTALL_PI=1 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done
[ -n "$NAME" ] || { echo "usage: $0 <sandbox-name> [--install-pi]" >&2; exit 1; }

# Take the provider definitions from the host's working config (single source of
# truth for API keys), then rewrite baseUrl for the sandbox's network view.
# Syncs every LOCALLY hosted provider (baseUrl on localhost/127.0.0.1, any
# port); remote providers are not copied into the sandbox.
HOST_MODELS="${USERPROFILE:+$USERPROFILE/.pi/agent/models.json}"
[ -f "${HOST_MODELS:-/nonexistent}" ] || HOST_MODELS="$HOME/.pi/agent/models.json"
[ -f "$HOST_MODELS" ] || { echo "host models.json not found (looked in \$USERPROFILE and \$HOME)" >&2; exit 1; }

# A hostname is "local" in either place a baseUrl can live: on the provider, or
# on an individual model that overrides it. Both get rewritten to the VM's view
# of the host; anything else (a remote provider) stays out of the sandbox.

PROVIDER_JSON=$("$NODE" -e '
const m = require(process.argv[1]);
const localHost = (h) => ["localhost", "127.0.0.1", "[::1]"].includes(h);
const provs = (m && m.providers) || {};
const out = { providers: {} };
let rewrittenModels = 0;
for (const [name, p] of Object.entries(provs)) {
  let u;
  try { u = new URL(p.baseUrl || ""); } catch { continue; }
  if (!localHost(u.hostname)) continue; // remote provider: not for the sandbox
  u.hostname = "host.docker.internal"; // same port + path, host view from the VM
  const copy = { ...p, baseUrl: u.toString() };
  if (Array.isArray(p.models)) {
    copy.models = p.models.map((mo) => {
      if (!mo || !mo.baseUrl) return mo;
      let mu;
      try { mu = new URL(mo.baseUrl); } catch { return mo; }
      if (!localHost(mu.hostname)) return mo; // model pointing elsewhere: leave it alone
      mu.hostname = "host.docker.internal";
      rewrittenModels++;
      return { ...mo, baseUrl: mu.toString() };
    });
  }
  out.providers[name] = copy;
}
if (!Object.keys(out.providers).length) { console.error("no locally hosted providers found in " + process.argv[1]); process.exit(1); }
if (rewrittenModels) console.error("[note] rewrote " + rewrittenModels + " per-model baseUrl override(s) for the VM");
console.log(JSON.stringify(out, null, 2));
' "$HOST_MODELS")

# Default-model candidates: provider/model plus the URL to probe, one per line,
# in preference order. "strata" became "strata-iq3_xxs" when the profiles were
# renamed, so the match is a prefix, not a name.
CANDIDATES=$("$NODE" -e '
const m = require(process.argv[1]);
const provs = (m && m.providers) || {};
const local = Object.entries(provs).filter(([name, p]) => {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(p.baseUrl || "").hostname); } catch { return false; }
});
if (!local.length) process.exit(1);
const rank = ([n]) => n === "unsloth-studio" ? 0 : /^strata/.test(n) ? 1 : 2;
local.sort((a, b) => rank(a) - rank(b));
for (const [name, p] of local) {
  if (!p.models || !p.models.length) continue;
  // Probe the URL the VM will actually use, not the host-side one — 127.0.0.1
  // inside the microVM is the microVM, so probing the host URL answers 000 for
  // every provider and every candidate looks dead. Probe the effective URL of
  // the model being considered: a per-model override can point at a different
  // port than the provider (one Strata provider, two server ports).
  // (No apostrophes in comments inside these single-quoted node scripts — an
  // apostrophe ends the string and bash then parses JavaScript.)
  const mo = p.models[0];
  let u;
  try { u = new URL(mo.baseUrl || p.baseUrl); } catch { continue; }
  u.hostname = "host.docker.internal";
  console.log(name + "/" + mo.id + " " + u.toString());
}
' "$HOST_MODELS")
if [ -z "$CANDIDATES" ]; then echo "error: no locally hosted provider with a model found in $HOST_MODELS" >&2; exit 1; fi

# Ask the VM which of those endpoints actually answers. A provider copied from
# the host is not the same as a provider that is running: picking one that is
# configured-but-dead made every message in the sandbox fail with
# "Connection error."
#
# What the codes mean here, measured on this box:
#   200        the host service is really there (Strata :8890, audio.cpp :8097)
#   401/403    something serves that port and wants a key — alive
#   500        NOT a server: Docker Desktop's host.docker.internal gateway dials
#              the host loopback FROM THE HOST and reports the refusal verbatim
#              ("dial tcp [::1]:8888: connectex: ...actively refused"). A dead
#              port and an unregistered port both look like this. Control runs on
#              empty ports 8899/9999 returned the same 500.
#   000        curl could not even reach the gateway
# That 500 is also why a loopback-only listener works from a sandbox at all:
# the hop happens on the host side, so nothing needs to bind 0.0.0.0.
probe_code() {
  local C
  # "< /dev/null" is not decoration: sbx exec reads stdin, and inside a
  # `while read` loop fed by a here-string that swallows every remaining
  # candidate — the loop then tests one provider and reports "no provider
  # answered". Same reason for the REASON fetch below.
  C=$("$SBX" exec "$NAME" -- bash -c "curl -s -m 5 -o /dev/null -w '%{http_code}' '$1'" </dev/null 2>/dev/null || true)
  C=$(tr -dc '0-9' <<<"$C" | head -c 3)
  [ -n "$C" ] || C=000
  printf '%s' "$C"
}
DEFAULT_MODEL=""
while read -r CAND MODEL_URL; do
  CODE=$(probe_code "$MODEL_URL/models")
  case "$CODE" in
    2??|401|403|404) ALIVE=1 ;;
    *) ALIVE=0 ;;
  esac
  if [ "$ALIVE" = 0 ]; then
    echo "[skip] $CAND ($MODEL_URL) — HTTP $CODE, not a live model server"
    if [ "$CODE" = "500" ]; then
      # Surface the gateway's own words: it says which host port it tried.
      REASON=$("$SBX" exec "$NAME" -- bash -c "curl -s -m 5 '$MODEL_URL/models'" </dev/null 2>/dev/null | tr -d '\r\n' | head -c 120)
      [ -n "$REASON" ] && echo "       gateway said: $REASON"
    fi
    continue
  fi
  DEFAULT_MODEL="$CAND"
  echo "[ok] $CAND answered from inside the VM (HTTP $CODE) — default model"
  break
done <<< "$CANDIDATES"
if [ -z "$DEFAULT_MODEL" ]; then
  DEFAULT_MODEL=$(head -1 <<< "$CANDIDATES" | cut -d" " -f1)
  echo "[warn] no local provider answered — setting $DEFAULT_MODEL anyway, start the engine or switch with /model"
fi

# Provider the default model belongs to.
PROVIDER_NAME="${DEFAULT_MODEL%%/*}"

"$SBX" exec "$NAME" -- bash -c 'mkdir -p ~/.pi/agent && cat > ~/.pi/agent/models.json <<EOF
'"$PROVIDER_JSON"'
EOF'

# Merge the default model into settings.json — a full overwrite would wipe
# everything pi wrote there (packages, theme, changelog version, ...), which
# is what made `pi install .` look like it had to re-run on every launch.
"$SBX" exec "$NAME" -- node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const f = path.join(os.homedir(), ".pi", "agent", "settings.json");
let s = {};
try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
s.defaultProvider = process.argv[2];
s.defaultModel = process.argv[1];
fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
' "${DEFAULT_MODEL#*/}" "$PROVIDER_NAME"

if [ "$INSTALL_PI" = 1 ]; then
  "$SBX" exec "$NAME" -- bash -c 'if [ -f package.json ]; then pi install .; else echo "[skip] no package.json in workspace"; fi'
fi

echo "[done] sandbox $NAME can now use: pi --model $DEFAULT_MODEL"
