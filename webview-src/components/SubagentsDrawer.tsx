import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { formatCost, formatTokens } from "../lib/format";

/** Minimal shape the inspector needs (mirrors SessionSummary). */
export interface SubagentInfo {
  id: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  time: { created: number; updated: number; idle?: number };
}

interface Props {
  subagents: SubagentInfo[];
  initialId?: string;
  onClose(): void;
}

interface TailMessage {
  type: string;
  text?: string;
  time?: { created?: number };
}

/**
 * Subagent Execution Inspector: live tail of a child session's messages,
 * its bound model/agent, token usage, and a Terminate (interrupt) control.
 * Polls messages.list while open — child-session events are not routed to
 * the main feed, and polling matches the main feed's fallback behavior.
 */
export function SubagentsDrawer({ subagents, initialId, onClose }: Props) {
  const [selected, setSelected] = useState<string | undefined>(
    () => initialId ?? subagents[0]?.id,
  );
  const [tail, setTail] = useState<TailMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const tailRef = useRef<HTMLDivElement>(null);

  const current = subagents.find((s) => s.id === selected) ?? subagents[0];

  const refreshTail = useCallback(async (sessionID: string | undefined) => {
    if (!sessionID) return;
    try {
      const rows = await rpc.call<
        Array<{
          type?: string;
          text?: string;
          finish?: string;
          content?: Array<{ type?: string; text?: string }>;
          time?: { created?: number };
        }>
      >("messages.list", { sessionID });
      const shaped = rows.slice(-40).map((m) => ({
        type: m.type ?? "?",
        finish: m.finish,
        time: m.time,
        text:
          m.text ??
          (m.content ?? [])
            .filter((c) => c?.type === "text")
            .map((c) => c.text ?? "")
            .join(" "),
      }));
      setTail(shaped);
      const assistants = shaped.filter((m) => m.type === "assistant");
      const last = assistants[assistants.length - 1];
      // Busy only when an assistant turn is actually open. An empty tail
      // (or text-only steps with no assistant message yet) is NOT busy —
      // otherwise ■ Terminate shows with nothing to interrupt.
      setBusy(last != null && last.finish === undefined);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void refreshTail(current?.id);
    if (!current) return;
    const id = setInterval(() => void refreshTail(current.id), 1500);
    return () => clearInterval(id);
  }, [current?.id, refreshTail]);

  // Newest at bottom — keep tail pinned to bottom like main feed
  useEffect(() => {
    const el = tailRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [tail]);

  const terminate = async (): Promise<void> => {
    if (!current) return;
    try {
      await rpc.call("prompt.interrupt", { sessionID: current.id });
      await refreshTail(current.id);
    } catch {
      /* surfaced via state on next poll */
    }
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="prov-name">Subagents</span>
        <span className="micro">
          {subagents.filter((s) => s.time.idle === undefined).length} active
        </span>
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          done
        </button>
      </div>

      {subagents.length === 0 && (
        <div className="drawer-empty">No subagent runs in this session.</div>
      )}

      <div className="drawer-list">
        {subagents.map((s) => {
          const active = s.time.idle === undefined;
          return (
            <button
              key={s.id}
              type="button"
              className={`model-row${current?.id === s.id ? " sel" : ""}`}
              style={{ textAlign: "left", cursor: "pointer" }}
              onClick={() => setSelected(s.id)}
            >
              <span className={`dot ${active ? "busy" : "off"}`} />
              <span className="model-name" title={s.title ?? s.agent}>
                {s.title || s.agent || "subagent"}
              </span>
              <span className="model-meta">
                {s.model ? `${s.model.providerID}/${s.model.id}` : ""}
              </span>
            </button>
          );
        })}
      </div>

      {current && (
        <>
          <div className="menu-section">inspector — live tail</div>
          <div className="strip" style={{ padding: "2px 8px" }}>
            <span className="micro">
              {current.agent ?? "build"} ·{" "}
              {formatTokens(
                (current.tokens?.input ?? 0) +
                  (current.tokens?.output ?? 0) +
                  (current.tokens?.reasoning ?? 0),
              )}{" "}
              tok · {formatCost(current.cost ?? 0)}
            </span>
            <span className="spacer" />
            {busy && (
              <button
                type="button"
                className="danger"
                title="Interrupt this subagent run"
                onClick={() => void terminate()}
              >
                ■ Terminate
              </button>
            )}
          </div>
          <div
            ref={tailRef}
            className="drawer-list"
            style={{ maxHeight: "45vh", overflowY: "auto" }}
          >
            {tail.map((m, i) =>
              m.type === "user" ? (
                <div key={i} className="drawer-empty">
                  ▸ {(m.text ?? "").slice(0, 160)}
                </div>
              ) : m.type === "assistant" ? (
                <div key={i} className="model-row">
                  <span
                    className="model-name"
                    style={{ whiteSpace: "pre-wrap" }}
                    title={`step @ ${m.time?.created ?? "?"}`}
                  >
                    {(m.text ?? "").slice(0, 200) ||
                      (m as { finish?: string }).finish ||
                      "…"}
                  </span>
                </div>
              ) : null,
            )}
          </div>
        </>
      )}

      <div className="strip">
        <span className="micro">
          subagent sessions run under their parent · events stay server-side
        </span>
      </div>
    </div>
  );
}
