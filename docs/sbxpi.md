# sbxpi — setup, management & gotchas

Detailed companion to the [Real sandbox section of the README](../README.md#real-sandbox-docker-sandboxes-sbx):
one-time setup per machine, day-to-day sandbox commands, and sbxpi-specific
notes. Everything here assumes `sbxpi` does the launching — for how Docker
Sandboxes itself works, see the [official docs](https://docs.docker.com/ai/sandboxes/).

## One-time setup (per machine)

- The [`sbx` CLI](https://docs.docker.com/ai/sandboxes/install/) — signed in. **No
  Docker Desktop or Docker Engine needed**: sbx ships its own microVM runtime.
  - macOS (Sonoma 14+, Apple silicon): `brew trust docker/tap && brew install docker/tap/sbx`
  - Windows 11 (64-bit, Hypervisor Platform enabled): `winget install -h Docker.sbx`
  - Linux: the standalone `docker-sbx` package (or Docker's convenience script with
    `SBX=1` if you also want Docker Engine)
  - After installing, sign in once (`sbx` prompts / `sbx login`); the CLI then lives
    on your PATH or in `%LOCALAPPDATA%\DockerSandboxes\bin` (Windows default).
- A bash and Node.js — on Windows that means Git for Windows (the scripts run
  under its bash; WSL's `System32\bash.exe` won't do, the shims pin Git Bash
  explicitly). On Linux/macOS your existing bash/node are fine.
- **Add `<this repo>\bin` to your PATH** — that's it. The directory contains a
  self-locating `sbxpi` shim per shell family (`sbxpi` for bash-family shells,
  `sbxpi.ps1` for PowerShell, `sbxpi.cmd` for cmd), so the command works in
  **any terminal on any OS** with no per-shell configuration. New terminals pick
  the entry up on launch.

## Managing sandboxes

| Command | Effect |
|---|---|
| `sbx ls` | list sandboxes (name, agent, status, workspace) |
| `sbx run --name <n>` | attach to one |
| `sbx stop <n>` | pause, keep the VM (fast restart) |
| `sbx rm <n>` / `sbx rm --force <n…>` | delete — removes the VM and everything in it |
| `sbx prune` | delete all stopped sandboxes |

## Notes & gotchas

- **The workspace is a live read-write mount** — the sandboxed pi edits your real
  files. Don't launch from your home directory: that would mount your entire
  profile read-write into the VM.
- Sandboxes persist until `sbx rm`; re-running `sbxpi` just re-provisions and
  re-attaches (resuming the last session), so model-config changes on the host
  propagate on your next launch. `sbxpi --new` skips the resume.
- **Paths above the workspace are VM-local:** the parent directories you see in
  the VM (`/c/...` up the tree) are *not* views of your host folders — anything
  the agent creates there lives only inside the VM and dies with it. When the
  model narrates "I can access the parent folder", that is contained.
- **No Anthropic, by design:** `sbxpi` suppresses the pi kit's interactive
  credential prompt and adds per-sandbox **deny** rules for
  `api.anthropic.com` / `platform.claude.com` — we run a local model. (The local
  model is reached via `host.docker.internal:8888`, which resolves to your host
  from inside the VM; no network-policy rules needed.)
- **Yolo by default:** sandboxes created by `sbxpi` carry `HUMBLE_PI_YOLO=1`
  (baked in via `sbx create --env`), so new sessions start with yolo mode on —
  the microVM is the isolation boundary, the path guard would only add noise.
  `/guards yolo off` switches it back for a session; see
  [Yolo mode](../README.md#yolo-mode).
