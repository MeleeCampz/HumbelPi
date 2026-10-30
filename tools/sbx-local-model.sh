#!/usr/bin/env bash
# Wire an sbx pi sandbox to the local model (Unsloth Studio, or Strata as fallback).
#
# Each sbx sandbox is a fresh microVM: pi starts with no providers because the
# host's ~/.pi/agent is not imported. This script writes a models.json into the
# sandbox's agent dir, pointing at the host via host.docker.internal (verified
# reachable from inside the microVM; plain localhost/127.0.0.1 are the VM itself).
# Provider choice: "unsloth-studio" from the host models.json if present
# (port 8888), else "strata" (port 8889).
#
# Usage: tools/sbx-local-model.sh <sandbox-name> [--install-pi]
#   --install-pi  also run `pi install .` in the sandbox's workspace (if it is a pi package)
#
# Syncs every locally hosted provider from the host models.json (baseUrl host
# rewritten to host.docker.internal, port/path kept). Default model:
# unsloth-studio if defined, else strata, else the first local provider.
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

PROVIDER_JSON=$("$NODE" -e '
const m = require(process.argv[1]);
const provs = (m && m.providers) || {};
const out = { providers: {} };
for (const [name, p] of Object.entries(provs)) {
  const u = new URL(p.baseUrl || "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) continue; // remote provider: not for the sandbox
  u.hostname = "host.docker.internal"; // same port + path, host view from the VM
  out.providers[name] = { ...p, baseUrl: u.toString() };
}
if (!Object.keys(out.providers).length) { console.error("no locally hosted providers found in " + process.argv[1]); process.exit(1); }
console.log(JSON.stringify(out, null, 2));
' "$HOST_MODELS")

# Default model for the sandbox's pi: prefer unsloth-studio, then strata, then
# the first local provider - so it starts on the local model.
DEFAULT_MODEL=$("$NODE" -e '
const m = require(process.argv[1]);
const provs = (m && m.providers) || {};
const local = Object.entries(provs).filter(([, p]) => {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(p.baseUrl || "").hostname); } catch { return false; }
});
if (!local.length) process.exit(1);
const [name, p] = local.find(([n]) => n === "unsloth-studio") || local.find(([n]) => n === "strata") || local[0];
if (!p.models || !p.models.length) process.exit(1);
console.log(name + "/" + p.models[0].id);
' "$HOST_MODELS")

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
