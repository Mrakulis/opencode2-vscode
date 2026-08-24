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

function extractToolDelta(data: DeltaEvent["data"]): string | undefined {
  if (!data) return undefined;
  if (typeof data.delta === "string") return data.delta;
  if (typeof data.text === "string") return data.text;
  const meta = (data as { metadata?: unknown }).metadata;
  if (typeof meta === "string") return meta;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    if (typeof m.delta === "string") return m.delta;
    if (typeof m.text === "string") return m.text;
    if (typeof m.output === "string") return m.output;
    // fallback: first non-empty string value
    for (const v of Object.values(m)) if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Apply one delta; returns a NEW array or null when it cannot be applied. */
export function applyDelta(
  messages: AnyMessage[],
  evt: DeltaEvent,
): AnyMessage[] | null {
  const data = evt.data;

  // ---- terminal / tool deltas (shell output streams via tool progress) ----
  if (
    evt.type === "session.tool.progress" ||
    evt.type === "session.tool.input.delta"
  ) {
    const assistantMessageID =
      (data?.assistantMessageID as string | undefined) ??
      (data?.messageID as string | undefined);
    const toolID =
      (data?.id as string | undefined) ?? (data as { toolID?: string })?.toolID;
    const delta = extractToolDelta(data);
    if (!assistantMessageID || !toolID || typeof delta !== "string") return null;

    const idx = messages.findIndex((m) => m.id === assistantMessageID);
    if (idx === -1) return null;
    const candidate = messages[idx] as unknown as {
      type?: string;
      content?: Array<Record<string, unknown>>;
    };
    if (
      !candidate ||
      candidate.type !== "assistant" ||
      !Array.isArray(candidate.content)
    )
      return null;

    const toolIdx = candidate.content.findIndex(
      (p) => p.type === "tool" && (p.id === toolID || (p as { toolID?: string }).toolID === toolID),
    );
    if (toolIdx === -1) return null;

    const tool = candidate.content[toolIdx] as unknown as {
      id: string;
      type: string;
      state?: { status?: string; content?: Array<Record<string, unknown>> };
    };
    const state = tool.state ?? {};
    const toolContent: Array<Record<string, unknown>> = Array.isArray(state.content)
      ? [...state.content]
      : [];
    // Append to the last text block inside the tool, or create one.
    const last = toolContent[toolContent.length - 1];
    if (last && last.type === "text" && typeof last.text === "string") {
      toolContent[toolContent.length - 1] = { ...last, text: (last.text as string) + delta };
    } else {
      toolContent.push({ type: "text", text: delta });
    }

    const nextTool = { ...tool, state: { ...state, content: toolContent } };
    const nextContent = [...candidate.content];
    nextContent[toolIdx] = nextTool as unknown as Record<string, unknown>;

    const out = [...messages];
    out[idx] = {
      ...(messages[idx] as unknown as Record<string, unknown>),
      content: nextContent,
    } as unknown as AnyMessage;
    return out;
  }

  if (
    evt.type !== "session.text.delta" &&
    evt.type !== "session.reasoning.delta"
  )
    return null;
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