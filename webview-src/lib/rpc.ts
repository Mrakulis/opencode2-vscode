import type { InboundMessage } from "../../src/protocol";
import { isInbound } from "../../src/protocol";

type PushHandler = (msg: InboundMessage) => void;

/**
 * Webview-side RPC client over the VS Code postMessage bridge.
 * Requests carry a monotonic id; responses resolve the matching promise.
 */
class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pushHandlers = new Set<PushHandler>();
  private readonly api: { postMessage(message: unknown): void };

  constructor() {
    this.api = acquireVsCodeApi();
    window.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (!data || typeof data !== "object") return;
      if (isRpcResult(data)) {
        const entry = this.pending.get(data.id);
        if (!entry) return;
        this.pending.delete(data.id);
        // Settle the timeout too — otherwise timers accumulate during
        // streaming (dozens per minute).
        if (entry.timer) clearTimeout(entry.timer);
        if (data.ok) entry.resolve(data.result);
        else entry.reject(new Error(data.error ?? "rpc failed"));
        return;
      }
      if (isInbound(data)) {
        for (const handler of this.pushHandlers) handler(data);
      }
    });
  }

  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id))
          reject(new Error(`rpc ${method} timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.api.postMessage({ type: "rpc", id, method, params: params ?? {} });
    });
  }

  onPush(handler: PushHandler): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }
}

function isRpcResult(value: unknown): value is {
  type: "rpcResult";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "rpcResult" &&
    typeof (value as { id?: unknown }).id === "number"
  );
}

export const rpc = new RpcClient();

// ---- typed helpers ---------------------------------------------------------

export interface ModelOption {
  id: string;
  providerID: string;
  name: string;
  context?: number;
  variants?: Array<{ id: string }>;
}

export interface AgentOption {
  id: string;
  name: string;
}

export interface SessionSummary {
  id: string;
  title?: string;
  /** Present when this session is a subagent run of a parent session. */
  parentID?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  time: {
    created: number;
    updated: number;
    idle?: number;
    viewed?: number;
    archived?: number;
  };
  location: { directory: string };
}

export interface MessagePartText {
  type: "text";
  text: string;
}
export interface MessagePartReasoning {
  type: "reasoning";
  text: string;
}
export interface MessagePartTool {
  type: "tool";
  id: string;
  name: string;
  state:
    | { status: "streaming" }
    | { status: "running" }
    | {
        status: "completed";
        input: Record<string, unknown>;
        content: ToolContent[];
      }
    | { status: "error"; error?: { message?: string } };
}
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "file"; uri?: string; mime?: string; name?: string }
  | { type: string; [k: string]: unknown };

export type AnyMessage =
  | {
      type: "user";
      id: string;
      text: string;
      time: { created: number };
      files?: Array<{ uri?: string; name?: string }>;
    }
  | {
      type: "assistant";
      id: string;
      agent: string;
      model?: { id: string; providerID: string; variant?: string };
      time: { created: number; completed?: number };
      content: Array<MessagePartText | MessagePartReasoning | MessagePartTool>;
      cost?: number;
      tokens?: SessionSummary["tokens"];
      finish?: string;
      error?: unknown;
    }
  | { type: string; id?: string };

export function isUser(
  m: AnyMessage,
): m is Extract<AnyMessage, { type: "user" }> {
  return m.type === "user";
}
export function isAssistant(
  m: AnyMessage,
): m is Extract<AnyMessage, { type: "assistant" }> {
  return m.type === "assistant";
}
