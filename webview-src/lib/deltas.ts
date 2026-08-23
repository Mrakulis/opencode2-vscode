import type { AnyMessage } from "./rpc";

/**
 * Incremental delta application for true streaming (Q17).
 *
 * Merges `session.text.delta` / `session.reasoning.delta` payloads into the
 * cached message list so the feed updates without a full refetch. Returns null
 * when the event cannot be applied (unknown message/part) — callers then fall
 * back to the debounced REST refresh. Pure + unit-testable.
 */

export interface DeltaEvent {
  type: string;
  data?: {
    sessionID?: string;
    messageID?: string;
    partID?: string;
    text?: string;
    [k: string]: unknown;
  };
}

interface AssistantLike {
  id: string;
  content: Array<{ type: string; text?: string }>;
}

/** Apply one delta; returns a NEW array or null when it cannot be applied. */
export function applyDelta(messages: AnyMessage[], evt: DeltaEvent): AnyMessage[] | null {
  if (evt.type !== "session.text.delta" && evt.type !== "session.reasoning.delta") return null;
  const messageID = evt.data?.messageID;
  const text = evt.data?.text;
  if (!messageID || typeof text !== "string") return null;

  const idx = messages.findIndex((m) => m.id === messageID);
  if (idx === -1) return null;
  const candidate = messages[idx] as unknown as { type?: string; content?: AssistantLike["content"] };
  if (!candidate || candidate.type !== "assistant" || !Array.isArray(candidate.content)) return null;

  const partKind = evt.type === "session.text.delta" ? "text" : "reasoning";
  const content: AssistantLike["content"] = [...candidate.content];
  const pIdx = content.findIndex((p) => p.type === partKind);
  if (pIdx === -1) {
    // start of a new block
    content.push({ type: partKind, text });
  } else {
    const existing = content[pIdx]!;
    content[pIdx] = { ...existing, text: (existing.text ?? "") + text };
  }

  const out = [...messages];
  out[idx] = { ...(messages[idx] as unknown as Record<string, unknown>), content } as unknown as AnyMessage;
  return out;
}
