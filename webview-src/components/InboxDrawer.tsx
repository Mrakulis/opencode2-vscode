import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

interface InboxItem {
  id: string;
  type?: string;
  delivery?: string;
  text?: string;
}

/**
 * Queued-follow-up drawer: lists pending inbox items for a session and lets
 * you steer them into the current run, keep them queued, or cancel them.
 * Backed by V2 session.inbox.* (the delivery chip sets the default; this
 * drawer manages individual items).
 */
export function InboxDrawer({
  sessionId,
  refreshTick,
  onClose,
}: {
  sessionId: string;
  /** Bumped by inbox.* events so the drawer live-refreshes while open. */
  refreshTick?: number;
  onClose(): void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const rows = await rpc.call<Array<Record<string, unknown>>>("inbox.list", {
        sessionID: sessionId,
      });
      setItems(
        rows.map((r) => {
          const payload = (r.payload ?? {}) as Record<string, unknown>;
          return {
            id: typeof r.id === "string" ? r.id : "",
            type: typeof r.type === "string" ? r.type : undefined,
            delivery: typeof r.delivery === "string" ? r.delivery : undefined,
            text: typeof payload.text === "string" ? payload.text : undefined,
          };
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const act = async (
    id: string,
    fn: "inbox.steer" | "inbox.queue" | "inbox.cancel",
  ): Promise<void> => {
    try {
      await rpc.call(fn, { sessionID: sessionId, inboxID: id });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Inbox">
        <header className="drawer-head">
          <span className="drawer-title">Inbox — queued follow-ups</span>
          <button type="button" className="iconbtn" onClick={onClose}>×</button>
        </header>
        {error && <div className="composer-error">{error}</div>}
        <div className="drawer-list">
          {items.length === 0 && !error && (
            <div className="drawer-empty">No queued follow-ups.</div>
          )}
          {items.map((it) => (
            <div key={it.id} className="session-row">
              <div style={{ flex: 1, overflow: "hidden" }}>
                <div className="session-title">
                  {it.text ?? `${it.type ?? "item"} (${it.id})`}
                </div>
                <div className="session-meta">
                  {it.type ?? "user"} · {it.delivery ?? "?"}
                </div>
              </div>
              <span
                className="rowdel"
                style={{ opacity: 0.8, display: "flex", gap: "4px", position: "static", transform: "none" }}
              >
                <button
                  type="button"
                  className="chip"
                  title="Steer into the current run"
                  onClick={() => void act(it.id, "inbox.steer")}
                >
                  steer
                </button>
                <button
                  type="button"
                  className="chip"
                  title="Keep queued (deliver after the current run)"
                  onClick={() => void act(it.id, "inbox.queue")}
                >
                  queue
                </button>
                <button
                  type="button"
                  className="chip on"
                  title="Cancel this follow-up"
                  onClick={() => void act(it.id, "inbox.cancel")}
                >
                  cancel
                </button>
              </span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}