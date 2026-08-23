import { useMemo, useState } from "react";
import { formatCost, formatTokens, relativeTime, totalTokens } from "../lib/format";
import type { SessionSummary } from "../lib/rpc";

interface Props {
  sessions: SessionSummary[];
  activeId?: string;
  allProjects: boolean;
  onToggleAll(): void;
  onSelect(id: string): void;
  onNew(): void;
  onDelete(id: string): Promise<void>;
}

/** Slides over the feed; Esc closes (handled in App). */
export function SessionsDrawer({ sessions, activeId, allProjects, onToggleAll, onSelect, onNew, onDelete }: Props) {
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<string | undefined>(undefined);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated);
    if (!q) return sorted;
    return sorted.filter((s) => (s.title ?? "").toLowerCase().includes(q) || s.id.includes(q));
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
          title={allProjects ? "Showing every project" : "Scoped to the opened folder"}
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
                <button type="button" className="menu-item manage" onClick={onToggleAll} style={{ marginTop: "8px" }}>
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
        {filtered.map((s) => (
          <div
            key={s.id}
            className={`session-row${s.id === activeId ? " active" : ""}`}
            onClick={() => onSelect(s.id)}
            role="presentation"
          >
            <span className="session-title">{s.title ?? "Untitled"}</span>
            <span className="session-meta">
              {formatTokens(totalTokens(s.tokens))} tok · {formatCost(s.cost)} · {relativeTime(s.time.updated)}
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
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
