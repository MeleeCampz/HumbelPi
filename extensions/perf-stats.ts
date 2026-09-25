/**
 * perf-stats — per-LLM-call performance stats for the footer's model info line.
 *
 * The OpenAI backend standard (and every major provider) exposes no server-side
 * timing in API responses — only token usage. So this measures client-side from
 * pi's events, which is the industry-standard approach:
 *
 *   - TTFT        : before_provider_request → first content delta (text/thinking/toolcall)
 *   - gen tok/s   : exact, usage.output / streaming duration; live estimate (chars/4) while streaming
 *
 * #16: the prompt-eval estimate (prompt tokens / TTFT) was removed — it is off by a
 * large margin compared to the backend's real prefill numbers. TTFT + gen tok/s stay.
 *
 * Published via ctx.ui.setStatus("perf", …); guards.ts' custom footer renders it
 * on the existing model info line (no extra lines).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface UsageLike { input?: number; output?: number; [k: string]: unknown; }

export interface PerfInput {
  t0: number;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  usage?: UsageLike | null;
}

/** Pure: stats for one completed provider call. Rates in tokens/sec, times in ms. */
export function computeStats({ t0, firstDeltaAt, lastDeltaAt, usage }: PerfInput): { ttftMs: number | null; tps: number | null } {
  const ttftMs = firstDeltaAt != null && firstDeltaAt >= t0 ? firstDeltaAt - t0 : null;

  let tps: number | null = null;
  if ((usage?.output ?? 0) > 0 && firstDeltaAt != null && lastDeltaAt != null && lastDeltaAt > firstDeltaAt) {
    tps = usage.output / ((lastDeltaAt - firstDeltaAt) / 1000);
  }

  return { ttftMs, tps };
}

function formatRate(t: number): string {
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
  if (t >= 100) return String(Math.round(t));
  return t.toFixed(1);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Final per-call text, e.g. "42 t/s · TTFT 380ms"; null when nothing measurable. */
export function formatFinal(s: { ttftMs: number | null; tps: number | null }): string | null {
  const parts: string[] = [];
  if (s.tps != null) parts.push(`${formatRate(s.tps)} t/s`);
  if (s.ttftMs != null) parts.push(`TTFT ${formatMs(s.ttftMs)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export default function (pi: ExtensionAPI) {
  let t0 = 0;
  let firstDeltaAt: number | null = null;
  let lastDeltaAt: number | null = null;
  let streamedChars = 0;
  let active = false;
  let lastLivePublishAt = 0;

  const publish = (ctx: any, text: string | undefined): void => {
    try { ctx?.ui?.setStatus?.("perf", text); } catch { /* non-interactive mode */ }
  };

  pi.on("before_provider_request", () => {
    t0 = Date.now();
    firstDeltaAt = null;
    lastDeltaAt = null;
    streamedChars = 0;
    active = true;
  });

  pi.on("message_update", (e: any, ctx: any) => {
    if (!active || !t0) return;
    const ev = e?.assistantMessageEvent;
    if (!ev) return;
    if (ev.type === "error") { active = false; publish(ctx, undefined); return; }
    if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;

    const now = Date.now();
    if (firstDeltaAt == null) firstDeltaAt = now;
    lastDeltaAt = now;
    streamedChars += typeof ev.delta === "string" ? ev.delta.length : 0;

    // Live estimate (~4×/s): chars/4 over elapsed streaming time.
    const elapsed = (now - firstDeltaAt) / 1000;
    if (elapsed > 0.05 && now - lastLivePublishAt > 250) {
      const est = (streamedChars / 4) / elapsed;
      publish(ctx, `~${formatRate(est)} t/s …`);
      lastLivePublishAt = now;
    }
  });

  pi.on("message_end", (e: any, ctx: any) => {
    if (!active) return;
    const msg = e?.message;
    if (msg?.role !== "assistant") return;
    active = false;
    const s = computeStats({ t0, firstDeltaAt, lastDeltaAt, usage: msg.usage });
    publish(ctx, formatFinal(s) ?? undefined);
  });
}
