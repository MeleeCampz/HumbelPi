# sbxpi — run pi in a sandbox

`sbxpi` launches [pi](https://github.com/badlogic/pi-mono) inside a
[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) microVM with this
repo installed and your local model wired up — one command, from any project
folder:

```bash
cd /path/to/any/project
sbxpi
```

- **First run in a folder** creates everything: the sandbox (named
  `pi-<folder>`), the read-write workspace mount of your current folder, this
  repo mounted read-only, your local model as pi's default, and HumbelPi
  installed inside. Then it drops you into pi's TUI.
- **Every later run** reuses that sandbox: it re-provisions (so host-side
  model-config changes propagate), resumes your last session in the folder,
  and attaches. `sbxpi --new` starts a fresh session instead of resuming.

That's the whole workflow — `sbxpi` does all the launching; you never have to
call `sbx create` yourself. For how Docker Sandboxes itself works, see the
[official docs](https://docs.docker.com/ai/sandboxes/).

## One-time setup (per machine)

Do this once before your first `sbxpi`:

- The [`sbx` CLI](https://docs.docker.com/ai/sandboxes/install/) — signed in.
  **No Docker Desktop or Docker Engine needed**: sbx ships its own microVM
  runtime.
  - macOS (Sonoma 14+, Apple silicon): `brew trust docker/tap && brew install docker/tap/sbx`
  - Windows 11 (64-bit, Hypervisor Platform enabled): `winget install -h Docker.sbx`
  - Linux: the standalone `docker-sbx` package (or Docker's convenience script
    with `SBX=1` if you also want Docker Engine)
  - After installing, sign in once (`sbx` prompts / `sbx login`).
- A bash and Node.js — on Windows that means Git for Windows (the scripts run
  under its bash; WSL's `System32\bash.exe` won't do, the shims pin Git Bash
  explicitly). On Linux/macOS your existing bash/node are fine.
- **Add `<this repo>\bin` to your PATH** — that's it. The directory contains a
  self-locating `sbxpi` shim per shell family (`sbxpi` for bash-family shells,
  `sbxpi.ps1` for PowerShell, `sbxpi.cmd` for cmd), so the command works in
  **any terminal on any OS** with no per-shell configuration. New terminals pick
  the entry up on launch.

## Day-to-day

| Command | Effect |
|---|---|
| `sbxpi` | (re)launch pi in this folder's sandbox, resume last session |
| `sbxpi --new` | same, but a fresh session |
| `sbx ls` | list sandboxes (name, agent, status, workspace) |
| `sbx stop <n>` | pause, keep the VM (fast restart) |
| `sbx rm <n>` / `sbx rm --force <n…>` | delete — removes the VM and everything in it |
| `sbx prune` | delete all stopped sandboxes |

## Notes & gotchas

- **The workspace is a live read-write mount** — the sandboxed pi edits your real
  files. Don't launch from your home directory: that would mount your entire
  profile read-write into the VM.
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
- **Windows Terminal: Shift+Enter submits instead of inserting a newline.** WT
  sends the same bytes for Shift+Enter as for plain Enter (`\r`), and pi inside
  the VM cannot read modifier state (that Win32 detection only exists when pi
  runs natively on Windows). Fix in your `settings.json` — bind Shift+Enter to a
  `sendInput` action that injects a literal `\n`, which pi's editor treats as
  "insert newline":
  ```json
  "actions": [
    { "command": { "action": "sendInput", "input": "\n" }, "id": "User.sendNewLineInput" }
  ],
  "keybindings": [
    { "id": "User.sendNewLineInput", "keys": "shift+enter" }
  ]
  ```
  (A profile-level `sendInput` chord does NOT work for this — the keybinding
  form is required. Until you set it, **Ctrl+J** inserts a newline.)
