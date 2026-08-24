import type { AnyMessage } from "./rpc";

/**
 * Incremental delta application for true streaming (Q17).
 *
 * Merges `session.text.delta` / `session.reasoning.delta` payloads into the
 * cached message list so the feed updates without a full refetch. Returns null
 * when the event cannot be applied (unknown message/part) — callers then fall
 * back to the debounced REST refresh. Pure + unit-testable.
 *
 * V2 delta payloads identify the message via `assistantMessageID` (NOT
 * `messageID`) and the part via `ordinal`; legacy `messageID` is tolerated.
 */

export interface DeltaEvent {
  type: string;
  data?: {
    sessionID?: string;
    assistantMessageID?: string;
    messageID?: string;
    ordinal?: number;
    partID?: string;
    delta?: string;
    text?: string;
    [k: string]: unknown;
  };
}

interface PartLike {
  type: string;
  text?: string;
}

interface AssistantLike {
  id: string;
  content: Array<PartLike>;
}

/** Apply one delta; returns a NEW array or null when it cannot be applied. */
export function applyDelta(
  messages: AnyMessage[],
  evt: DeltaEvent,
): AnyMessage[] | null {
  if (
    evt.type !== "session.text.delta" &&
    evt.type !== "session.reasoning.delta"
  )
    return null;
  const data = evt.data;
  // V2 uses assistantMessageID; tolerate the legacy messageID spelling.
  const assistantMessageID = data?.assistantMessageID ?? data?.messageID;
  const delta = typeof data?.delta === "string" ? data.delta : data?.text;
  if (!assistantMessageID || typeof delta !== "string") return null;

  const idx = messages.findIndex((m) => m.id === assistantMessageID);
  if (idx === -1) return null;
  const candidate = messages[idx] as unknown as {
    type?: string;
    content?: AssistantLike["content"];
  };
  if (
    !candidate ||
    candidate.type !== "assistant" ||
    !Array.isArray(candidate.content)
  )
    return null;

  const partKind = evt.type === "session.text.delta" ? "text" : "reasoning";
  const content: PartLike[] = [...candidate.content];
  const ordinal =
    typeof data?.ordinal === "number" && Number.isInteger(data.ordinal)
      ? data.ordinal
      : undefined;

  // 1) ordinal points at a matching part → append there.
  if (ordinal !== undefined) {
    const at = content[ordinal];
    if (at && at.type === partKind) {
      content[ordinal] = { ...at, text: (at.text ?? "") + delta };
    } else if (at && at.type !== partKind) {
      // The part exists but is a different kind (e.g. ordinal is a global part
      // index across text/reasoning) — find the matching part instead.
      appendToMatching(content, partKind, delta);
    } else {
      // Insert a new part at the ordinal slot (may fill leading gaps as {}).
      while (content.length < ordinal) content.push({ type: partKind, text: "" });
      content[ordinal] = { type: partKind, text: delta };
    }
  } else {
    appendToMatching(content, partKind, delta);
  }

  const out = [...messages];
  out[idx] = {
    ...(messages[idx] as unknown as Record<string, unknown>),
    content,
  } as unknown as AnyMessage;
  return out;
}

function appendToMatching(
  content: PartLike[],
  partKind: string,
  delta: string,
): void {
  const pIdx = content.findIndex((p) => p.type === partKind);
  if (pIdx === -1) {
    content.push({ type: partKind, text: delta });
  } else {
    const existing = content[pIdx]!;
    content[pIdx] = { ...existing, text: (existing.text ?? "") + delta };
  }
}