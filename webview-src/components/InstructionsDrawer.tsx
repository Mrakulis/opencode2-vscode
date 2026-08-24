import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

interface Entry {
  key: string;
  value: unknown;
}

/**
 * Project instructions (rules) editor backed by the V2
 * session.instructions.entry endpoints — the GUI home of `/init`.
 */
export function InstructionsDrawer({
  sessionId,
  onClose,
  refreshTick = 0,
}: {
  sessionId: string;
  onClose(): void;
  refreshTick?: number;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const rows = await rpc.call<Array<Record<string, unknown>>>(
        "instructions.list",
        { sessionID: sessionId },
      );
      const list = rows
        .map((r) => ({
          key: typeof r.key === "string" ? r.key : "",
          value: r.value,
        }))
        .filter((r) => r.key.length > 0);
      setEntries(list);
      setDrafts(
        Object.fromEntries(
          list.map((e) => [
            e.key,
            typeof e.value === "string" ? e.value : JSON.stringify(e.value),
          ]),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh on session.instructions.updated (event router bump).
  useEffect(() => {
    if (refreshTick > 0) void load();
  }, [refreshTick, load]);

  const save = async (key: string): Promise<void> => {
    const raw = drafts[key] ?? "";
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* keep as string */
    }
    try {
      await rpc.call("instructions.put", { sessionID: sessionId, key, value });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (key: string): Promise<void> => {
    try {
      await rpc.call("instructions.remove", { sessionID: sessionId, key });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label="Instructions"
      >
        <header className="drawer-head">
          <span className="drawer-title">Instructions</span>
          <button type="button" className="iconbtn" onClick={onClose}>
            ×
          </button>
        </header>
        {error && <div className="composer-error">{error}</div>}
        <div className="drawer-body">
          {entries.map((e) => (
            <div
              key={e.key}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                marginBottom: "10px",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "6px" }}
              >
                <code className="perm-res" style={{ flex: 1 }}>
                  {e.key}
                </code>
                <button
                  type="button"
                  className="rowdel"
                  title="Delete entry"
                  onClick={() => void remove(e.key)}
                >
                  ×
                </button>
              </div>
              <textarea
                className="search"
                rows={3}
                value={drafts[e.key] ?? ""}
                onChange={(ev) =>
                  setDrafts((d) => ({ ...d, [e.key]: ev.target.value }))
                }
                onBlur={() => void save(e.key)}
              />
            </div>
          ))}
          <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
            <input
              className="search"
              placeholder="new-rule-key"
              value={newKey}
              onChange={(ev) => setNewKey(ev.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={!newKey.trim()}
              onClick={() => {
                if (!newKey.trim()) return;
                setDrafts((d) => ({ ...d, [newKey.trim()]: "" }));
                setEntries((list) => [
                  ...list.filter((x) => x.key !== newKey.trim()),
                  { key: newKey.trim(), value: "" },
                ]);
                setNewKey("");
              }}
            >
              Add
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
