import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

interface WorktreeRow {
  name?: string;
  directory?: string;
  branch?: string;
}

/** Git worktree manager (V2 worktree.* endpoints) — in scope per review (Q22). */
export function WorktreesDrawer({
  onClose,
  refreshTick = 0,
}: {
  onClose(): void;
  refreshTick?: number;
}) {
  const [projectID, setProjectID] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<WorktreeRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    try {
      let pid = projectID;
      if (!pid) {
        const cur = await rpc.call<Record<string, unknown> | undefined>(
          "project.current",
        );
        const loc = cur?.location as Record<string, unknown> | undefined;
        const project = loc?.project as Record<string, unknown> | undefined;
        pid =
          (typeof cur?.projectID === "string" ? cur.projectID : undefined) ??
          (typeof project?.id === "string" ? project.id : undefined);
        setProjectID(pid);
      }
      if (!pid) {
        setError("No project context available for worktrees.");
        return;
      }
      const list = await rpc.call<Array<Record<string, unknown>>>(
        "worktree.list",
        { projectID: pid },
      );
      setRows(
        list.map((r) => ({
          name: typeof r.name === "string" ? r.name : undefined,
          directory:
            typeof r.directory === "string"
              ? r.directory
              : typeof r.path === "string"
                ? r.path
                : undefined,
          branch: typeof r.branch === "string" ? r.branch : undefined,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectID]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh when the event router bumps worktreeTick (worktree.updated/resolved).
  useEffect(() => {
    if (refreshTick > 0) void refreshAfterUpdate();
  }, [refreshTick]);

  // Re-read without re-resolving an already-known project id.
  async function refreshAfterUpdate(): Promise<void> {
    if (!projectID) return;
    try {
      const list = await rpc.call<Array<Record<string, unknown>>>(
        "worktree.list",
        { projectID },
      );
      setRows(
        list.map((r) => ({
          name: typeof r.name === "string" ? r.name : undefined,
          directory:
            typeof r.directory === "string"
              ? r.directory
              : typeof r.path === "string"
                ? r.path
                : undefined,
          branch: typeof r.branch === "string" ? r.branch : undefined,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const create = async (): Promise<void> => {
    if (!projectID) return;
    try {
      await rpc.call("worktree.create", {
        projectID,
        directory: ".",
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (directory: string | undefined): Promise<void> => {
    if (!projectID || !directory) return;
    try {
      await rpc.call("worktree.remove", { projectID, directory, force: false });
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
        aria-label="Worktrees"
      >
        <header className="drawer-head">
          <span className="drawer-title">Worktrees</span>
          <button type="button" className="iconbtn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="drawer-body">
          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            <input
              className="search"
              placeholder="new worktree name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={!projectID}
              onClick={() => void create()}
            >
              Add
            </button>
          </div>
          {error && <div className="composer-error">{error}</div>}
          {rows.length === 0 && !error && (
            <div className="drawer-empty">No worktrees yet.</div>
          )}
          {rows.map((r, i) => (
            <div
              key={(r.directory ?? r.name ?? "") + i}
              className="session-row"
            >
              <div style={{ flex: 1, overflow: "hidden" }}>
                <div className="session-title">
                  {r.name ?? r.directory ?? "(unnamed)"}
                </div>
                <div className="session-meta">
                  {r.branch ?? ""} {r.directory ?? ""}
                </div>
              </div>
              <button
                type="button"
                className="rowdel"
                title={r.directory ? "Remove worktree" : "Cannot remove"}
                disabled={!r.directory}
                onClick={() => void remove(r.directory)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
