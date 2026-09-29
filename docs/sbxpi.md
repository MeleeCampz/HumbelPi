# sbxpi — setup, management & gotchas

Detailed companion to the [Real sandbox section of the README](../README.md#real-sandbox-docker-sandboxes-sbx):
one-time setup per machine, day-to-day sandbox commands, and how it works under
the hood.

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

## How it works / gotchas

- **The workspace is a live read-write mount** — the sandboxed pi edits your real
  files. For isolation from your working tree, create with `sbx create --clone`
  (agent works on a private clone; not yet wired into `sbxpi`).
- **Reaching the local model:** all egress from the microVM is dialed by a proxy on
  the host, and `host.docker.internal` resolves to your machine — so
  `127.0.0.1:8888` (the VM's own loopback) fails while `host.docker.internal:8888`
  reaches llama-server. No extra network-policy rules needed.
- Sandboxes persist until `sbx rm`; re-running `sbxpi` just re-provisions and
  re-attaches (resuming the last session), so model-config changes on the host
  propagate on your next launch. `sbxpi --new` skips the resume.
- Don't launch from your home directory — that mounts your entire profile
  read-write into the VM.
- **Paths above the workspace are VM-local:** the parent directories you see in
  the VM (`/c/...` up the tree) are plain scaffold directories, *not* views of
  your host folders. Anything the agent creates there (stray `AGENTS.md`,
  scratch dirs) lives only inside the VM and dies with it — when the model
  narrates "I can access the parent folder", that is contained.
- **No Anthropic, by design:** Docker's pi kit bakes in egress allows for
  `api.anthropic.com` / `platform.claude.com` and asks interactively whether to
  bind an Anthropic credential when a sandbox is created. Since we run a local
  model, `sbxpi` runs the create with detached stdin so sbx takes the default
  (no binding, no prompt), and adds per-sandbox **deny** rules for both hosts
  (deny outranks the kit's read-only allows). `registry.npmjs.org` stays
  allowed — pi needs it for package installs.
- **Yolo by default:** sandboxes created by `sbxpi` carry `HUMBLE_PI_YOLO=1`
  (baked in via `sbx create --env`), so new sessions start with yolo mode on —
  the microVM is the isolation boundary, the path guard would only add noise.
  `/guards yolo off` switches it back for a session; see
  [Yolo mode](../README.md#yolo-mode).
