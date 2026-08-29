import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

interface InboxItem {
  id: string;
  type?: string;
  delivery?: string;
  text?: string;
  files?: Array<{ uri: string; name?: string }>;
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
  onEdit,
}: {
  sessionId: string;
  /** Bumped by inbox.* events so the drawer live-refreshes while open. */
  refreshTick?: number;
  onClose(): void;
  onEdit?(text: string, files?: Array<{ uri: string; name?: string }>): void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const rows = await rpc.call<Array<Record<string, unknown>>>("inbox.list", {
        sessionID: sessionId,
      });
      setItems(
        rows.map((r) => {
          const payload = (r.payload ?? {}) as Record<string, unknown>;
          const rawFiles = payload.files;
          const files = Array.isArray(rawFiles)
            ? (rawFiles as Array<Record<string, unknown>>)
                .filter((f) => typeof f?.uri === "string")
                .map((f) => ({
                  uri: f.uri as string,
                  name: typeof f.name === "string" ? f.name : undefined,
                }))
            : undefined;
          return {
            id: typeof r.id === "string" ? r.id : "",
            type: typeof r.type === "string" ? r.type : undefined,
            delivery: typeof r.delivery === "string" ? r.delivery : undefined,
            text: typeof payload.text === "string" ? payload.text : undefined,
            files: files && files.length > 0 ? files : undefined,
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

  // Fallback poll while drawer open (SSE may stall)
  useEffect(() => {
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (
    id: string,
    fn: "inbox.steer" | "inbox.queue" | "inbox.cancel",
  ): Promise<void> => {
    setBusyId(id);
    try {
      await rpc.call(fn, { sessionID: sessionId, inboxID: id });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(undefined);
    }
  };

  const edit = async (it: InboxItem): Promise<void> => {
    if (!onEdit) return;
    setBusyId(it.id);
    try {
      await rpc.call("inbox.cancel", { sessionID: sessionId, inboxID: it.id });
      onEdit(it.text ?? "", it.files);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Inbox">
        <header className="drawer-head">
          <span className="drawer-title">Inbox — queued follow-ups</span>
          <span className="micro" title="steer = interrupt current run, queue = after run">
            steer · queue
          </span>
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
                  {it.type ?? "user"} ·{" "}
                  <span className={`chip${it.delivery === "steer" ? " on" : ""}`} style={{ padding: "0 4px", fontSize: "10px" }}>
                    {it.delivery ?? "?"}
                  </span>
                  {it.files && it.files.length > 0 && ` · 📎 ${it.files.map((f) => f.name ?? f.uri).join(", ")}`}
                </div>
              </div>
              <span className="inbox-actions">
                {onEdit && (
                  <button
                    type="button"
                    className="chip"
                    title="Edit queued prompt"
                    disabled={busyId === it.id}
                    onClick={() => void edit(it)}
                  >
                    ✎ edit
                  </button>
                )}
                <button
                  type="button"
                  className="chip"
                  title="Steer into the current run"
                  disabled={busyId === it.id}
                  onClick={() => void act(it.id, "inbox.steer")}
                >
                  steer
                </button>
                <button
                  type="button"
                  className="chip"
                  title="Keep queued (deliver after the current run)"
                  disabled={busyId === it.id}
                  onClick={() => void act(it.id, "inbox.queue")}
                >
                  queue
                </button>
                <button
                  type="button"
                  className="chip on"
                  title="Cancel this follow-up"
                  disabled={busyId === it.id}
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