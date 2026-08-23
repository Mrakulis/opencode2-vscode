import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

interface SavedRule {
  id?: string;
  action?: string;
  resource?: string;
  effect?: string;
}

/** Manager for the server-side "always allow" permission rules (V2 permission.saved). */
export function SavedPermissionsDrawer({ onClose }: { onClose(): void }) {
  const [rules, setRules] = useState<SavedRule[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const rows = await rpc.call<Array<Record<string, unknown>>>("permissions.saved");
      setRules(
        rows.map((r) => ({
          id: typeof r.id === "string" ? r.id : undefined,
          action: typeof r.action === "string" ? r.action : typeof (r as { type?: unknown }).type === "string" ? String((r as { type?: unknown }).type) : undefined,
          resource: typeof r.resource === "string" ? r.resource : typeof r.pattern === "string" ? r.pattern : undefined,
          effect: typeof r.effect === "string" ? r.effect : undefined,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (id: string | undefined): Promise<void> => {
    if (!id) return;
    setRules((list) => list.filter((r) => r.id !== id));
    try {
      await rpc.call("permissions.saved.remove", { id });
    } catch {
      void load();
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Saved permissions">
        <header className="drawer-head">
          <span className="drawer-title">Saved permissions</span>
          <button type="button" className="iconbtn" onClick={onClose}>×</button>
        </header>
        {error && <div className="composer-error">{error}</div>}
        <div className="drawer-body">
          {rules.length === 0 ? (
            <div className="drawer-empty">No saved rules yet. “Allow always” adds one.</div>
          ) : (
            rules.map((r, i) => (
              <div key={r.id ?? i} className="session-row">
                <code className="perm-res" style={{ flex: 1 }}>
                  [{r.effect ?? "allow"}] {r.action ?? "*"}: {r.resource ?? "*"}
                </code>
                <button
                  type="button"
                  className="rowdel"
                  title={r.id ? "Remove rule" : "Cannot remove (no id)"}
                  disabled={!r.id}
                  onClick={() => void remove(r.id)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
