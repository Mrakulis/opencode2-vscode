import type { AnyMessage } from "./rpc";

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