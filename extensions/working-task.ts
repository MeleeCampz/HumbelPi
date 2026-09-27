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
