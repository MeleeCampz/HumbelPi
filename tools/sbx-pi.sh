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

FOLDER="${1:-$PWD}"
[ -d "$FOLDER" ] || { echo "not a directory: $FOLDER" >&2; exit 1; }

BASE=$(basename "$FOLDER")
NAME="${2:-pi-$(echo "$BASE" | tr -cd 'A-Za-z0-9-')}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if sbx ls | awk '{print $1}' | grep -qx "$NAME"; then
  echo "[exists] sandbox $NAME already exists — re-provisioning only"
else
  sbx create --name "$NAME" "docker.io/sbx/pi-kit:latest" "$FOLDER"
fi

bash "$DIR/sbx-local-model.sh" "$NAME"

if [ -t 0 ] && [ -t 1 ]; then
  exec sbx run --name "$NAME"
fi
echo
echo "Attach with:  sbx run --name $NAME"
echo "Remove with:  sbx rm $NAME"
