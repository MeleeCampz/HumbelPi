#!/usr/bin/env bash
# Launch a ready-to-work pi sandbox for any folder: mounts the folder as the
# workspace, wires the local Unsloth Studio model, and prints the attach command.
#
# Usage: tools/sbx-pi.sh <folder> [sandbox-name]
#   sandbox-name  defaults to pi-<folder basename>
#
# Re-running for an existing sandbox skips creation and just re-provisions.
set -euo pipefail

FOLDER="${1:-}"
[ -n "$FOLDER" ] || { echo "usage: $0 <folder> [sandbox-name]" >&2; exit 1; }
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

echo
echo "Attach with:  sbx run --name $NAME"
echo "Remove with:  sbx rm $NAME"
