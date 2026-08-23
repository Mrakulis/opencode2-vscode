import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

interface IntegrationRow {
  id: string;
  name: string;
  methods: Array<{ type?: string } | string>;
  connections: unknown[];
}

interface ProviderRow {
  id: string;
  name: string;
  activation?: "auto" | "enabled" | "disabled";
}

interface Props {
  onClose(): void;
  refreshTick?: number;
}

/**
 * Providers & accounts: read-only status plus in-app connect flows
 * (key / OAuth / command) with the CLI handoff as a fallback.
 */
export function ProvidersDrawer({ onClose, refreshTick = 0 }: Props) {
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  // Reload on mount and whenever the event router bumps refreshTick
  // (integration.updated / integration.connection.updated).
  useEffect(() => {
    void (async () => {
      try {
        const res = await rpc.call<{
          integrations: IntegrationRow[];
          providers: ProviderRow[];
        }>("providers.list");
        setIntegrations(res.integrations ?? []);
        setProviders(res.providers ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refreshTick]);

  /** In-app connect: OAuth → browser; command → instructions; key → inline field. */
  const connect = async (it: IntegrationRow, methodTypes: string[]): Promise<void> => {
    if (busyId) return;
    setBusyId(it.id);
    setError(undefined);
    try {
      const keyDraft = keyDrafts[it.id];
      if (keyDraft && keyDraft.trim().length > 0) {
        await rpc.call("integration.connectKey", { integrationID: it.id, key: keyDraft.trim() });
        setKeyDrafts((d) => ({ ...d, [it.id]: "" }));
        return;
      }
      if (methodTypes.includes("oauth")) {
        const attempt = await rpc.call<{ url?: string }>("integration.oauthConnect", { integrationID: it.id });
        if (attempt.url) window.open(attempt.url, "_blank");
        return;
      }
      if (methodTypes.includes("command")) {
        // Fall through to the CLI handoff — the command flow needs a terminal anyway.
      }
      await rpc.call("providers.authCli", { name: it.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="prov-name">Providers &amp; accounts</span>
        <button type="button" onClick={onClose}>
          done
        </button>
      </div>

      <div className="drawer-list">
        {error && <div className="drawer-empty">{error}</div>}

        {!error && integrations.length === 0 && providers.length === 0 && (
          <div className="drawer-empty">No provider integrations reported.</div>
        )}

        {integrations.length > 0 && <div className="menu-section">accounts</div>}
        {integrations.map((it) => {
          const connected = it.connections?.length ?? 0;
          const methodTypes = [...new Set(it.methods?.map((m) => (typeof m === "string" ? m : (m.type ?? "?"))))];
          const hasKeyMethod = methodTypes.includes("key");
          return (
            <div key={it.id} className="model-row">
              <span className={`dot ${connected > 0 ? "ok" : "off"}`} />
              <span className="model-name" title={it.id}>
                {it.name}
              </span>
              <span className="model-meta">
                {connected > 0 ? `${connected} linked` : methodTypes.join("/")}
              </span>
              {connected === 0 && hasKeyMethod && (
                <input
                  className="search"
                  style={{ width: "90px", padding: "2px 4px" }}
                  placeholder="API key…"
                  type="password"
                  value={keyDrafts[it.id] ?? ""}
                  onChange={(e) => setKeyDrafts((d) => ({ ...d, [it.id]: e.target.value }))}
                />
              )}
              <button
                type="button"
                className="rowicon"
                disabled={busyId === it.id}
                title={
                  busyId === it.id
                    ? "Connecting…"
                    : hasKeyMethod && (keyDrafts[it.id] ?? "").trim().length > 0
                      ? "Connect with the entered API key"
                      : methodTypes.includes("oauth")
                        ? "Connect in browser (OAuth)"
                        : "Connect via CLI (opens a terminal)"
                }
                onClick={() =>
                  void connect(it, methodTypes).then(() => {
                    // re-fetch so the dot flips without waiting for an event
                    return rpc
                      .call<{ integrations: IntegrationRow[]; providers: ProviderRow[] }>("providers.list")
                      .then((res) => {
                        setIntegrations(res.integrations ?? []);
                        setProviders(res.providers ?? []);
                      })
                      .catch(() => undefined);
                  })
                }
              >
                ⇱
              </button>
            </div>
          );
        })}

        {providers.length > 0 && <div className="menu-section">providers</div>}
        {providers.map((p) => (
          <div key={p.id} className="model-row">
            <span className="model-name" title={p.id}>
              {p.name}
            </span>
            <span className="model-meta act">{p.activation ?? "?"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
