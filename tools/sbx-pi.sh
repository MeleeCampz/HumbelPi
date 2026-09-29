#!/usr/bin/env bash
# Launch a ready-to-work pi sandbox for any folder: mounts the folder as the
# workspace, wires the local Unsloth Studio model, and prints the attach command.
#
# Usage: tools/sbx-pi.sh [folder] [sandbox-name]
#   folder        defaults to the current directory — run it from anywhere
#   sandbox-name  defaults to pi-<folder basename>
#
# Re-running for an existing sandbox skips creation and just re-provisions.
# In an interactive terminal, drops you straight into pi (sbx run) when done.
set -euo pipefail

# bash.exe launched directly from PowerShell inherits a minimal PATH without
# Git Bash's own tool dirs — add them so basename/tr/awk/grep resolve.
export PATH="/usr/bin:/bin:$PATH"

# The interactive shell's PATH may lack sbx — resolve it with a Windows fallback
# (Docker Sandboxes' default install dir), else fail with a clear message.
if command -v sbx >/dev/null 2>&1; then
  SBX="sbx"
elif [ -n "${LOCALAPPDATA:-}" ] && [ -f "$LOCALAPPDATA/DockerSandboxes/bin/sbx.exe" ]; then
  SBX="$LOCALAPPDATA/DockerSandboxes/bin/sbx.exe"
else
  echo "error: sbx not found on PATH (looked in \$LOCALAPPDATA/DockerSandboxes/bin too). Install Docker Sandboxes or add it to PATH." >&2
  exit 1
fi

FOLDER="${1:-$PWD}"
[ -d "$FOLDER" ] || { echo "not a directory: $FOLDER" >&2; exit 1; }

BASE=$(basename "$FOLDER")
NAME="${2:-pi-$(echo "$BASE" | tr -cd 'A-Za-z0-9-')}"
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"

# HumbelPi ships with every sandbox: the repo is mounted read-only (unless it
# IS the workspace) and installed into the sandbox's pi.
HUMBLE_MOUNT=()
[ "$(readlink -f "$FOLDER")" != "$REPO" ] && HUMBLE_MOUNT=("$REPO:ro")

if "$SBX" ls | awk '{print $1}' | grep -qx "$NAME"; then
  echo "[exists] sandbox $NAME already exists — re-provisioning only"
else
  "$SBX" create --name "$NAME" "docker.io/sbx/pi-kit:latest" "$FOLDER" "${HUMBLE_MOUNT[@]}"
fi

bash "$DIR/sbx-local-model.sh" "$NAME"

# Install this package from its mount (read-only extra, or the workspace
# itself when the folder is this repo). No-op if already installed.
if "$SBX" exec "$NAME" -- pi list 2>/dev/null | grep -qF "$(basename "$REPO")"; then
  echo "[skip] $(basename "$REPO") already installed in $NAME"
else
  "$SBX" exec "$NAME" -- bash -c "cd '$REPO' && pi install ." && echo "[ok] $(basename "$REPO") installed in $NAME"
fi

if [ -t 0 ] && [ -t 1 ]; then
  exec "$SBX" run --name "$NAME"
fi
echo
echo "Attach with:  sbx run --name $NAME"
echo "Remove with:  sbx rm $NAME"
