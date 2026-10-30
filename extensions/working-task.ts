/**
 * working-task — let the model set/clear the "current task" shown in pi's
 * working indicator (the spinner line visible while streaming).
 *
 * Uses the built-in ExtensionUIContext.setWorkingMessage(message?):
 *   - setWorkingMessage("Refactoring guards.ts") → spinner shows that text
 *   - setWorkingMessage()                        → restores the default ("Working")
 *
 * The indicator only renders while the agent is streaming, so this is purely
 * a "what am I doing right now" signal for longer multi-step work. No-op in
 * non-interactive modes (RPC/print). A stale task never survives a session
 * switch: we clear it on session_start.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // #11: pi only resets the working message on session switch/reload — clear it
  // ourselves so a task from the previous session can't leak into a new one.
  pi.on("session_start", (_e, ctx) => {
    try { ctx.ui.setWorkingMessage?.(); } catch { /* non-interactive mode */ }
  });

  // #1: pi also keeps the message across RUNS. Press-tested behaviour (pi 1.4.0):
  //   run 1  → agent calls working_task("Rebuild guards") → spinner shows it
  //   run 2  → new user prompt, no working_task call yet → spinner shows
  //            "Rebuild guards" again, i.e. the LAST run's task, until the model
  //            happens to call working_task again. That is why "updating the current
  //            task often doesn't work" — what you see is stale text from earlier work.
  // A prompt typed while idle (streamingBehavior undefined) starts a new unit of work,
  // so reset there. Messages that arrive mid-run (steer / followUp) and messages an
  // extension injects (guards' /plan approve instruction, backlog actions, …) keep the
  // current task text — they are the same unit of work.
  pi.on("input", (e, ctx) => {
    if (e.source === "extension") return;
    if (e.streamingBehavior !== undefined) return;
    try { ctx.ui.setWorkingMessage?.(); } catch { /* non-interactive mode */ }
  });

  pi.registerTool({
    name: "working_task",
    label: "Working task",
    description:
      "Set or clear the current-task text shown in the working indicator while the agent is streaming. " +
      "Pass a short task description to display it, or an empty string to restore the default. " +
      "Use for longer multi-step work so the user always sees what is happening.",
    promptSnippet:
      "working_task(task) — set/clear the current task shown in the working indicator (empty string clears)",
    promptGuidelines: [
      "At the start of longer multi-step work, call working_task with a short description of the current task; update it between major steps and clear it (empty string) when done.",
      "Keep the text short (one line) — it is rendered in the spinner line next to the animation.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Short current-task description shown while working; empty string clears/resets to default" }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (params.task ?? "").trim();
      if (ctx.hasUI) {
        try { ctx.ui.setWorkingMessage(text || undefined); } catch { /* non-interactive mode */ }
      }
      return {
        content: [{ type: "text", text: text ? `Working indicator now shows "${text}" while I work.` : "Working indicator reset to default." }],
        details: undefined,
      };
    },
  });
}
