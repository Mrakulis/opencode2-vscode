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
}

/**
 * Read-only view of connected model providers/accounts, plus a terminal
 * handoff for connecting new ones (the CLI owns the OAuth browser flow).
 */
export function ProvidersDrawer({ onClose }: Props) {
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

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
  }, []);

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
          return (
            <div key={it.id} className="model-row">
              <span className={`dot ${connected > 0 ? "ok" : "off"}`} />
              <span className="model-name" title={it.id}>
                {it.name}
              </span>
              <span className="model-meta">
                {connected > 0 ? `${connected} linked` : methodTypes.join("/")}
              </span>
              <button
                type="button"
                className="rowicon"
                title="Connect via CLI (opens a terminal)"
                onClick={() =>
                  void rpc
                    .call("providers.authCli", { name: it.name })
                    .catch(() => undefined)
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
