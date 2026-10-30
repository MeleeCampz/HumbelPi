#!/usr/bin/env bash
# Launch a ready-to-work pi sandbox for any folder: mounts the folder as the
# workspace, wires the local model (Unsloth Studio, or Strata as fallback), and prints the attach command.
#
# Usage: tools/sbx-pi.sh [--new] [--gc] [folder] [sandbox-name]
#   folder        defaults to the current directory — run it from anywhere
#   sandbox-name  defaults to pi-<folder basename>
#   --new         start a fresh pi session instead of continuing the last one
#   --gc          deep-clean the sandbox (all caches incl. HF models &
#                 Playwright browsers, /tmp older than a day) instead of the
#                 light cleanup that runs on every launch
#
# Re-running for an existing sandbox skips creation and just re-provisions.
# In an interactive terminal, drops you straight into pi (sbx run) when done —
# by default it continues the last session in that folder (pi --continue);
# with no prior session it simply starts fresh.
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

NEW=0; GC=0; POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --new) NEW=1 ;;
    --gc) GC=1 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
FOLDER="${POSITIONAL[0]:-$PWD}"
[ -d "$FOLDER" ] || { echo "not a directory: $FOLDER" >&2; exit 1; }

BASE=$(basename "$FOLDER")
NAME="${POSITIONAL[1]:-pi-$(echo "$BASE" | tr -cd 'A-Za-z0-9-')}"
if [ "$NEW" -eq 1 ]; then PI_ARGS=""; else PI_ARGS="--continue"; fi
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"

# HumbelPi ships with every sandbox: the repo is mounted read-only (unless it
# IS the workspace) and installed into the sandbox's pi.
HUMBLE_MOUNT=()
[ "$(readlink -f "$FOLDER")" != "$REPO" ] && HUMBLE_MOUNT=("$REPO:ro")

if "$SBX" ls | awk '{print $1}' | grep -qx "$NAME"; then
  echo "[exists] sandbox $NAME already exists — re-provisioning only"
else
  # The pi kit asks interactively whether to bind an Anthropic credential at
  # create time. We run a local model, so detach stdin: sbx takes the default
  # (no binding) without prompting and just notes the credential was not
  # injected. (Only create loses its stdin — the later attach keeps the TTY.)
  # --env HUMBLE_PI_YOLO=1: yolo-by-default (one of three signals — see
  # yoloDefaultOn() in extensions/lib/session-state.ts). In a proper sandbox the
  # container IS the isolation boundary, so the path-sandbox guard would only add
  # noise. Baked in at create time so every attach method picks it up; sandboxes
  # created before this flag existed still get yolo ON via SANDBOX_NAME / /run/sandbox
  # detection, so no re-creation is needed.
  "$SBX" create --name "$NAME" --env HUMBLE_PI_YOLO=1 "docker.io/sbx/pi-kit:latest" "$FOLDER" "${HUMBLE_MOUNT[@]}" </dev/null
fi

# --- disk guard -------------------------------------------------------------
# The sandbox root FS is a fixed ~20G overlay. Agent sessions fill it with
# package caches (uv, pip) and /tmp venvs/eval data until the VM won't even
# boot (ENOSPC at overlayfs mount time → "docker daemon failed to start").
# Light cleanup on every launch; --gc for a deep clean.
# bash -c wrapper: sbx exec rewrites bare absolute-path args (a lone "/")
# through MSYS path translation when launched from Git Bash.
# Retries: the first exec after creation can race the cold VM boot.
UP=0
for _ in 1 2 3 4 5; do
  "$SBX" exec "$NAME" -- bash -c 'df -h /' >/dev/null 2>&1 && { UP=1; break; }
  sleep 6
done
if [ "$UP" -ne 1 ]; then
  echo "error: sandbox $NAME will not start — its root FS is likely full." >&2
  echo "Recreate it (host workspace files are safe):  sbx rm $NAME && sbxpi" >&2
  exit 1
fi
if [ "$GC" -eq 1 ]; then
  echo "[gc] deep-cleaning caches and /tmp in $NAME"
  "$SBX" exec "$NAME" -- bash -c 'rm -rf "$HOME/.cache/pip" "$HOME/.cache/uv" "$HOME/.cache/huggingface" "$HOME/.cache/ms-playwright"; find /tmp -mindepth 1 -maxdepth 1 -mtime +0 -exec rm -rf {} + 2>/dev/null' || true
else
  "$SBX" exec "$NAME" -- bash -c 'rm -rf "$HOME/.cache/pip" "$HOME/.cache/uv"; find /tmp -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf {} + 2>/dev/null' || true
fi
PCT=$("$SBX" exec "$NAME" -- bash -c 'df --output=pcent /' 2>/dev/null | tail -1 | tr -dc '0-9' || true)
if [ -n "$PCT" ] && [ "$PCT" -ge 80 ]; then
  echo "[warn] sandbox root FS at ${PCT}% — try: sbxpi --gc (deep clean), or recreate: sbx rm $NAME && sbxpi"
fi

bash "$DIR/sbx-local-model.sh" "$NAME"

# Deny the kit's baked-in Anthropic hosts (deny outranks the kit's read-only
# allows; npmjs.org stays allowed for pi's package installs). Idempotent.
# (Capture-then-grep: under pipefail, `cmd | grep -q` can fail via SIGPIPE
# when grep exits early, flipping the condition on every run.)
POLICY_LS=$("$SBX" policy ls "$NAME" --wide 2>/dev/null || true)
if ! grep -q "deny.*api.anthropic.com" <<<"$POLICY_LS"; then
  "$SBX" policy deny network --protocol tcp --sandbox "$NAME" api.anthropic.com >/dev/null 2>&1
  "$SBX" policy deny network --protocol tcp --sandbox "$NAME" platform.claude.com >/dev/null 2>&1
fi

# Install this package from its mount (read-only extra, or the workspace
# itself when the folder is this repo). No-op if already installed.
PI_LIST=$("$SBX" exec "$NAME" -- pi list 2>/dev/null || true)
if grep -qF "$(basename "$REPO")" <<<"$PI_LIST"; then
  echo "[skip] $(basename "$REPO") already installed in $NAME"
else
  "$SBX" exec "$NAME" -- bash -c "cd '$REPO' && pi install ." && echo "[ok] $(basename "$REPO") installed in $NAME"
fi

# NOTE: no "pi" after the "--" — the kit's entrypoint IS pi, and everything
# after "--" is appended to it. Passing "pi" again would make pi treat it as
# an initial prompt message (the model answers a stray "pi" on startup).
if [ -t 0 ] && [ -t 1 ]; then
  exec "$SBX" run --name "$NAME" -- $PI_ARGS
fi
echo
echo "Attach with:  sbx run --name $NAME -- $PI_ARGS"
echo "Remove with:  sbx rm $NAME"
