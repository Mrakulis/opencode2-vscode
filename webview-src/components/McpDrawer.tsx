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
  refreshTick?: number;
}

/**
 * Live MCP server management. Changes apply to the running service; they are
 * runtime-scoped (the service's own config), so the drawer says so.
 */
export function McpDrawer({ onClose, refreshTick = 0 }: Props) {
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [secrets, setSecrets] = useState<Record<string, string>>({});

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
    if (refreshTick > 0) void refresh();
  }, [refreshTick, refresh]);

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

  const statusBadge = (
    status: ServerStatus,
  ): { label: string; cls: string; title?: string } => {
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

  /** Store a labeled credential reference for this server (V2 credentials API). */
  const storeCredential = async (s: McpServerRow): Promise<void> => {
    if (!s.integrationID) return;
    const secret = secrets[s.name]?.trim();
    if (!secret) return;
    try {
      await rpc.call("credentials.update", {
        credentialID: s.integrationID,
        label: `${s.name} api key`,
      });
      // With the reference stored, route through the integration connect flow
      // (key first; falls back to OAuth browser flow when no key method).
      await rpc.call("integration.connectKey", {
        integrationID: s.integrationID,
        key: secret,
      });
      setSecrets((d) => ({ ...d, [s.name]: "" }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Clear the stored credential reference for this server. */
  const clearCredential = async (s: McpServerRow): Promise<void> => {
    if (!s.integrationID) return;
    try {
      await rpc.call("credentials.remove", { credentialID: s.integrationID });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Open the OAuth browser flow using the server's integration id. */
  const oauthConnect = async (s: McpServerRow): Promise<void> => {
    if (!s.integrationID) return;
    try {
      const attempt = await rpc.call<{ url?: string }>(
        "integration.oauthConnect",
        { integrationID: s.integrationID },
      );
      if (attempt.url) window.open(attempt.url, "_blank");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="prov-name">MCP servers</span>
        <span className="micro">runtime scope</span>
        <button
          type="button"
          className="primary"
          onClick={() => setAdding((v) => !v)}
        >
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
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-server"
            />
          </label>
          <label>
            type
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "remote" | "local")}
            >
              <option value="remote">remote (URL)</option>
              <option value="local">local (command)</option>
            </select>
          </label>
          {kind === "remote" ? (
            <label>
              URL
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
              />
            </label>
          ) : (
            <label>
              command (argv)
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx -y some-mcp-server"
              />
            </label>
          )}
          <label className="checkrow">
            <input
              type="checkbox"
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
            add as disabled
          </label>
          <button
            type="button"
            className="primary"
            disabled={
              !name.trim() ||
              (kind === "remote" ? !url.trim() : !command.trim())
            }
            onClick={() => void submitAdd()}
          >
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
            <div
              key={s.name}
              style={{ display: "flex", flexDirection: "column" }}
            >
              <div className="model-row mcp-row">
                <button
                  type="button"
                  className={`rowicon${isOpen ? " on" : ""}`}
                  onClick={() => setExpanded(isOpen ? undefined : s.name)}
                  title="details"
                >
                  <span className={`chev${isOpen ? " open" : ""}`}>▸</span>
                </button>
                <span
                  className={`dot ${badge.cls === "ok" ? "ok" : badge.cls === "dim" || badge.cls === "" ? "off" : "warn"}`}
                />
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
                    onClick={() =>
                      void rpc
                        .call("mcp.disconnect", { name: s.name })
                        .catch(() => undefined)
                    }
                  >
                    ⏻
                  </button>
                ) : s.status.status !== "disabled" ? (
                  <button
                    type="button"
                    className="rowicon"
                    title="Connect"
                    onClick={() =>
                      void rpc
                        .call("mcp.connect", { name: s.name })
                        .catch(() => undefined)
                    }
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
              {isOpen &&
                s.status.status === "needs_auth" &&
                s.integrationID && (
                  <div className="oc2-mcp-auth">
                    <input
                      className="search"
                      style={{ flex: 1 }}
                      type="password"
                      placeholder={`${s.name} API key…`}
                      value={secrets[s.name] ?? ""}
                      onChange={(e) =>
                        setSecrets((d) => ({ ...d, [s.name]: e.target.value }))
                      }
                    />
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void storeCredential(s)}
                    >
                      Set key
                    </button>
                    <button
                      type="button"
                      className="chip"
                      title="Sign in via browser (OAuth)"
                      onClick={() => void oauthConnect(s)}
                    >
                      OAuth
                    </button>
                    <button
                      type="button"
                      className="danger"
                      title="Clear the stored credential reference for this server"
                      onClick={() => void clearCredential(s)}
                    >
                      Clear
                    </button>
                  </div>
                )}
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
