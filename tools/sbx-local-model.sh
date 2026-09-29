#!/usr/bin/env bash
# Wire an sbx pi sandbox to the local Unsloth Studio model (host llama-server).
#
# Each sbx sandbox is a fresh microVM: pi starts with no providers because the
# host's ~/.pi/agent is not imported. This script writes a models.json into the
# sandbox's agent dir, pointing at the host via host.docker.internal (verified
# reachable from inside the microVM; plain localhost/127.0.0.1 are the VM itself).
#
# Usage: tools/sbx-local-model.sh <sandbox-name> [--install-pi]
#   --install-pi  also run `pi install .` in the sandbox's workspace (if it is a pi package)
set -euo pipefail

# bash.exe launched directly from PowerShell inherits a minimal PATH —
# restore Git Bash's own tool dirs (see sbx-pi.sh).
export PATH="/usr/bin:/bin:$PATH"

# The interactive shell's PATH may also lack sbx/node — pin fallbacks (this machine).
command -v sbx  >/dev/null 2>&1 || SBX="C:/Users/Tobias/AppData/Local/DockerSandboxes/bin/sbx.exe"
command -v node >/dev/null 2>&1 || NODE="C:/Program Files/nodejs/node.exe"
SBX="${SBX:-sbx}"; NODE="${NODE:-node}"

NAME="${1:-}"; shift || true
INSTALL_PI=0
for a in "$@"; do
  case "$a" in
    --install-pi) INSTALL_PI=1 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done
[ -n "$NAME" ] || { echo "usage: $0 <sandbox-name> [--install-pi]" >&2; exit 1; }

# Take the provider definition from the host's working config (single source of
# truth for the API key), then rewrite baseUrl for the sandbox's network view.
HOST_MODELS="${USERPROFILE:+$USERPROFILE/.pi/agent/models.json}"
[ -f "${HOST_MODELS:-/nonexistent}" ] || HOST_MODELS="$HOME/.pi/agent/models.json"
[ -f "$HOST_MODELS" ] || { echo "host models.json not found (looked in \$USERPROFILE and \$HOME)" >&2; exit 1; }

PROVIDER_JSON=$("$NODE" -e '
const m = require(process.argv[1]);
const p = m.providers && m.providers["unsloth-studio"];
if (!p) { console.error("unsloth-studio provider not found in " + process.argv[1]); process.exit(1); }
p.baseUrl = "http://host.docker.internal:8888/v1";
console.log(JSON.stringify({ providers: { "unsloth-studio": p } }, null, 2));
' "$HOST_MODELS")

# Default model for the sandbox's pi (first model of the provider), so it
# starts on the local model instead of pi's built-in default.
DEFAULT_MODEL=$("$NODE" -e '
const m = require(process.argv[1]);
const p = m.providers && m.providers["unsloth-studio"];
if (!p || !p.models || !p.models.length) process.exit(1);
console.log("unsloth-studio/" + p.models[0].id);
' "$HOST_MODELS")

"$SBX" exec "$NAME" -- bash -c 'mkdir -p ~/.pi/agent && cat > ~/.pi/agent/models.json <<EOF
'"$PROVIDER_JSON"'
EOF
cat > ~/.pi/agent/settings.json <<EOF
{"defaultProvider": "unsloth-studio", "defaultModel": "'"${DEFAULT_MODEL#unsloth-studio/}"'"}
EOF'

if [ "$INSTALL_PI" = 1 ]; then
  "$SBX" exec "$NAME" -- bash -c 'if [ -f package.json ]; then pi install .; else echo "[skip] no package.json in workspace"; fi'
fi

echo "[done] sandbox $NAME can now use: pi --model unsloth-studio/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M"
