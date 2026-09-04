import type { AnyMessage } from "./rpc";

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const r = e as Record<string, unknown>;
    if (typeof r.message === "string" && r.message) return r.message;
    if (typeof r.error === "string" && r.error) return r.error;
    try {
      const s = JSON.stringify(r);
      if (s && s !== "{}" && s !== "[]") return s.slice(0, 2000);
    } catch {}
  }
  return String(e);
}

/** True when a failure looks provider/model-related (smart-retry material). */
export const PROVIDERISH_RE =
  /provider|invalid-request|invalid_request|invalid request|invalid parameters|upstream request failed|console go|policy|guardrail|no endpoints|model|finish_reason|stream ended/i;

/**
 * Message-failure predicates — pure helpers kept out of `lib/rpc.ts` because
 * that module instantiates the webview RPC bridge at import time and cannot
 * be loaded under plain node tests. Type-only imports are erased at runtime.
 */

/**
 * True when an assistant message records a failed run: an `error` object,
 * `finish === "error"`, or a persisted server-retry marker (`retry.attempt`).
 * Verified against live V2 payloads — failed steps carry all/some of these
 * while healthy steps have finish "stop"/"tool-calls" and no error object.
 */
export function assistantFailed(
  m: AnyMessage,
): m is Extract<AnyMessage, { type: "assistant" }> & {
  error?: { message?: string };
} {
  if (!isAssistantMessage(m)) return false;
  return (
    m.error != null ||
    m.finish === "error" ||
    (m as unknown as { retry?: unknown }).retry !== undefined
  );
}

function isAssistantMessage(
  m: AnyMessage,
): m is Extract<AnyMessage, { type: "assistant" }> {
  return m.type === "assistant";
}

/**
 * True when an assistant message ended because its run was INTERRUPTED — the
 * question hand-back auto-interrupt, or the user pressing ■ Stop. These are
 * expected aborts (live shapes `{type:"aborted",message:"Step interrupted"}`
 * and `{type:"aborted",message:"Tool execution interrupted"}`) and must render
 * as a neutral status note, not a red failure — even though the server marks
 * them `finish: "error"`.
 */
export function isExpectedInterruption(m: AnyMessage): boolean {
  if (!isAssistantMessage(m)) return false;
  const err = m.error;
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: unknown; message?: unknown };
  const type = String(e.type ?? "").toLowerCase();
  const msg = String(e.message ?? "").toLowerCase();
  return (
    type === "aborted" ||
    /interrupted|abort/i.test(type) ||
    /interrupted|abort/i.test(msg)
  );
}