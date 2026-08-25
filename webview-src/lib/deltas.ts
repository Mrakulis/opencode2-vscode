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

  // ---- terminal / write deltas (shell output + file writes stream) ----
  // shell output comes via `session.tool.progress` (output side),
  // file writes come via `session.tool.input.delta` (input side — the file
  // content / newString being streamed). Handle both so the diff view grows live.
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
    if (!assistantMessageID || typeof delta !== "string") return null;
    // toolID may not be present on very early input deltas — still try to
    // attach to the last tool in the message.
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

    let toolIdx = -1;
    if (toolID) {
      toolIdx = candidate.content.findIndex(
        (p) => p.type === "tool" && (p.id === toolID || (p as { toolID?: string }).toolID === toolID),
      );
    }
    // Early input deltas can arrive before the tool part exists in the
    // snapshot — fall back to the last tool (the one currently streaming).
    if (toolIdx === -1) {
      for (let i = candidate.content.length - 1; i >= 0; i--) {
        if (candidate.content[i]?.type === "tool") { toolIdx = i; break; }
      }
    }
    if (toolIdx === -1) return null;

    const tool = candidate.content[toolIdx] as unknown as {
      id: string;
      type: string;
      name?: string;
      state?: {
        status?: string;
        input?: Record<string, unknown>;
        content?: Array<Record<string, unknown>>;
      };
    };

    // For input deltas (write/edit) update the *input* field so the
    // synthesized diff (which reads oldString/newString/content) grows live.
    if (evt.type === "session.tool.input.delta") {
      const input = { ...(tool.state?.input ?? {}) };
      const name = typeof tool.name === "string" ? tool.name.toLowerCase() : "";
      // Heuristic: write → "content", edit → "newString", otherwise first string field.
      let field: string | undefined;
      if (name === "write" && typeof input.content === "string") field = "content";
      else if (name === "edit" && typeof input.newString === "string") field = "newString";
      else if (typeof input.content === "string") field = "content";
      else if (typeof input.newString === "string") field = "newString";
      else {
        for (const [k, v] of Object.entries(input)) if (typeof v === "string") { field = k; break; }
      }
      // If the input object is still empty (very early delta), create the field.
      if (!field) {
        field = name === "write" ? "content" : "newString";
        (input as Record<string, unknown>)[field] = delta;
      } else {
        (input as Record<string, unknown>)[field] = ((input[field] as string) ?? "") + delta;
      }
      const nextTool = { ...tool, state: { ...(tool.state ?? {}), input } };
      const nextContent = [...candidate.content];
      nextContent[toolIdx] = nextTool as unknown as Record<string, unknown>;
      const out = [...messages];
      out[idx] = {
        ...(messages[idx] as unknown as Record<string, unknown>),
        content: nextContent,
      } as unknown as AnyMessage;
      return out;
    }

    // Progress → append to the tool's output content (terminal streaming).
    const state = tool.state ?? {};
    const toolContent: Array<Record<string, unknown>> = Array.isArray(state.content)
      ? [...state.content]
      : [];
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
  // Ordinal clamp: a hostile/garbled frame with a huge integer must never
  // trigger the placeholder-fill loop below (verified: ordinal 1e9 OOM-crashes
  // the webview). Out-of-range ordinals fall back to append-to-matching.
  const ordinal =
    typeof data?.ordinal === "number" &&
    Number.isInteger(data.ordinal) &&
    data.ordinal >= 0 &&
    data.ordinal <= 256
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
    } else if (ordinal <= content.length) {
      // Append at the next free slot.
      content[ordinal] = { type: partKind, text: delta };
    } else {
      appendToMatching(content, partKind, delta);
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