import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

type ServerStatus =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" };

interface McpServerRow {
  name: string;
  status: ServerStatus;
  integrationID?: string;
}

interface Props {
  onClose(): void;
}

/**
 * Live MCP server management. Changes apply to the running service; they are
 * runtime-scoped (the service's own config), so the drawer says so.
 */
export function McpDrawer({ onClose }: Props) {
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  // add form state
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"remote" | "local">("remote");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [disabled, setDisabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await rpc.call<{ data: McpServerRow[] }>("mcp.list");
      setServers(res.data ?? []);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = rpc.onPush((msg) => {
      if (msg.type === "event") {
        const evt = msg.event as { type?: string } | undefined;
        if (evt?.type?.startsWith("mcp.")) void refresh();
      }
    });
    return off;
  }, [refresh]);

  const submitAdd = async (): Promise<void> => {
    const clean = name.trim();
    if (!clean) return;
    try {
      if (kind === "remote") {
        await rpc.call("mcp.add", {
          name: clean,
          config: { type: "remote", url: url.trim(), disabled },
        });
      } else {
        const argv = command.trim().split(/\s+/).filter(Boolean);
        await rpc.call("mcp.add", {
          name: clean,
          config: { type: "local", command: argv, disabled },
        });
      }
      setAdding(false);
      setName("");
      setUrl("");
      setCommand("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const statusBadge = (status: ServerStatus): { label: string; cls: string; title?: string } => {
    switch (status.status) {
      case "connected":
        return { label: "✓ connected", cls: "ok" };
      case "pending":
        return { label: "… pending", cls: "" };
      case "disabled":
        return { label: "disabled", cls: "dim" };
      case "needs_auth":
        return { label: "⚠ needs auth", cls: "warn" };
      case "failed":
        return { label: "✗ failed", cls: "err", title: status.error };
    }
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="prov-name">MCP servers</span>
        <span className="micro">runtime scope</span>
        <button type="button" className="primary" onClick={() => setAdding((v) => !v)}>
          {adding ? "cancel" : "+ Add"}
        </button>
        <button type="button" onClick={onClose}>
          done
        </button>
      </div>

      {!adding && error && <div className="drawer-empty">{error}</div>}

      {adding && (
        <div className="mcp-form">
          <label>
            name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
          </label>
          <label>
            type
            <select value={kind} onChange={(e) => setKind(e.target.value as "remote" | "local")}>
              <option value="remote">remote (URL)</option>
              <option value="local">local (command)</option>
            </select>
          </label>
          {kind === "remote" ? (
            <label>
              URL
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
            </label>
          ) : (
            <label>
              command (argv)
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y some-mcp-server" />
            </label>
          )}
          <label className="checkrow">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            add as disabled
          </label>
          <button type="button" className="primary" disabled={!name.trim() || (kind === "remote" ? !url.trim() : !command.trim())} onClick={() => void submitAdd()}>
            Add server
          </button>
        </div>
      )}

      <div className="drawer-list">
        {!adding && servers.length === 0 && !error && (
          <div className="drawer-empty">No MCP servers registered.</div>
        )}
        {servers.map((s) => {
          const badge = statusBadge(s.status);
          const isOpen = expanded === s.name;
          return (
            <div key={s.name} className="model-row mcp-row">
              <button
                type="button"
                className={`rowicon${isOpen ? " on" : ""}`}
                onClick={() => setExpanded(isOpen ? undefined : s.name)}
                title="details"
              >
                <span className={`chev${isOpen ? " open" : ""}`}>▸</span>
              </button>
              <span className={`dot ${badge.cls === "ok" ? "ok" : badge.cls === "dim" || badge.cls === "" ? "off" : "warn"}`} />
              <span className="model-name" title={s.name}>
                {s.name}
              </span>
              <span className={`model-meta ${badge.cls}`} title={badge.title}>
                {badge.label}
              </span>
              {s.status.status === "connected" ? (
                <button
                  type="button"
                  className="rowicon"
                  title="Disconnect"
                  onClick={() => void rpc.call("mcp.disconnect", { name: s.name }).catch(() => undefined)}
                >
                  ⏻
                </button>
              ) : s.status.status !== "disabled" ? (
                <button
                  type="button"
                  className="rowicon"
                  title="Connect"
                  onClick={() => void rpc.call("mcp.connect", { name: s.name }).catch(() => undefined)}
                >
                  ⟳
                </button>
              ) : null}
              <button
                type="button"
                className="rowicon eye"
                title="Remove server"
                onClick={() =>
                  void rpc
                    .call("mcp.remove", { name: s.name })
                    .then(() => refresh())
                    .catch(() => undefined)
                }
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div className="strip">
        <span className="micro">changes apply to the running service</span>
        <span className="spacer" />
      </div>
    </div>
  );
}
