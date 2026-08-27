import { useMemo, useState } from "react";
import {
  formatCost,
  formatTokens,
  relativeTime,
  totalTokens,
} from "../lib/format";
import type { SessionSummary } from "../lib/rpc";

interface Props {
  sessions: SessionSummary[];
  activeId?: string;
  /** Sessions currently running in ANY client window (cross-window pulse). */
  runningIds?: ReadonlySet<string>;
  allProjects: boolean;
  onToggleAll(): void;
  onSelect(id: string): void;
  onNew(): void;
  onDelete(id: string): Promise<void>;
  onMove(id: string): Promise<void>;
}

/** Slides over the feed; Esc closes (handled in App). */
export function SessionsDrawer({
  sessions,
  activeId,
  runningIds,
  allProjects,
  onToggleAll,
  onSelect,
  onNew,
  onDelete,
  onMove,
}: Props) {
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<string | undefined>(undefined);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...sessions].sort(
      (a, b) => b.time.updated - a.time.updated,
    );
    if (!q) return sorted;
    return sorted.filter(
      (s) => (s.title ?? "").toLowerCase().includes(q) || s.id.includes(q),
    );
  }, [sessions, query]);

  return (
    <div className="drawer">
      <div className="drawer-head">
        <input
          className="search"
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button
          type="button"
          className={`chip${allProjects ? " on" : ""}`}
          title={
            allProjects
              ? "Showing every project"
              : "Scoped to the opened folder"
          }
          onClick={onToggleAll}
        >
          {allProjects ? "all projects" : "this folder"}
        </button>
        <button type="button" className="primary" onClick={onNew}>
          + New
        </button>
      </div>

      <div className="drawer-list">
        {filtered.length === 0 && (
          <div className="drawer-empty">
            {query.trim() ? (
              "No matching sessions."
            ) : sessions.length === 0 && !allProjects ? (
              <>
                No sessions in this folder.
                <br />
                <button
                  type="button"
                  className="menu-item manage"
                  onClick={onToggleAll}
                  style={{ marginTop: "8px" }}
                >
                  Show all projects
                </button>
              </>
            ) : sessions.length === 0 ? (
              "No sessions yet — start a new one."
            ) : (
              "No matching sessions."
            )}
          </div>
        )}
        {filtered.map((s) => {
          const unread = (s.time.idle ?? 0) > (s.time.viewed ?? 0);
          const running = runningIds?.has(s.id) ?? false;
          return (
            <div
              key={s.id}
              className={`session-row${s.id === activeId ? " active" : ""}${
                unread ? " unread" : ""
              }${running ? " running" : ""}`}
              onClick={() => onSelect(s.id)}
              role="presentation"
              title={
                running
                  ? "Running in another window"
                  : unread
                    ? "Finished — not viewed yet"
                    : undefined
              }
            >
              <span className="session-title">
                {s.title ?? "Untitled"}
                {running && (
                  <span className="session-dot running" title="Running" />
                )}
                {unread && (
                  <span className="session-dot unread" title="Unread" />
                )}
              </span>
              <span className="session-meta">
                {formatTokens(totalTokens(s.tokens))} tok · {formatCost(s.cost)}{" "}
                · {relativeTime(s.time.updated)}
              </span>
              {confirming === s.id ? (
                <span className="confirm">
                  <button
                    type="button"
                    className="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDelete(s.id);
                      setConfirming(undefined);
                    }}
                  >
                    delete
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirming(undefined);
                    }}
                  >
                    keep
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="rowdel"
                    style={{ right: "26px" }}
                    title="Move to another workspace folder"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onMove(s.id);
                    }}
                  >
                    ⇄
                  </button>
                  <button
                    type="button"
                    className="rowdel"
                    title="Delete session"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirming(s.id);
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
