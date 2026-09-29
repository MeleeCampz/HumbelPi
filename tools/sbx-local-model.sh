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

PROVIDER_JSON=$(node -e '
const m = require(process.argv[1]);
const p = m.providers && m.providers["unsloth-studio"];
if (!p) { console.error("unsloth-studio provider not found in " + process.argv[1]); process.exit(1); }
p.baseUrl = "http://host.docker.internal:8888/v1";
console.log(JSON.stringify({ providers: { "unsloth-studio": p } }, null, 2));
' "$HOST_MODELS")

sbx exec "$NAME" -- bash -c 'mkdir -p ~/.pi/agent && cat > ~/.pi/agent/models.json <<EOF
'"$PROVIDER_JSON"'
EOF'

if [ "$INSTALL_PI" = 1 ]; then
  sbx exec "$NAME" -- bash -c 'if [ -f package.json ]; then pi install .; else echo "[skip] no package.json in workspace"; fi'
fi

echo "[done] sandbox $NAME can now use: pi --model unsloth-studio/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M"
