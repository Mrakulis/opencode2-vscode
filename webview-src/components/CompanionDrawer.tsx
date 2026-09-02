import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

interface CompanionConfig {
  enabled: boolean;
  hostname: string;
  port: number;
  username: string;
  password: string;
  cors: string[];
}

interface CompanionStatus {
  config: CompanionConfig;
  url?: string;
  running: boolean;
}

interface Props {
  onClose(): void;
}

export function CompanionDrawer({ onClose }: Props) {
  const [status, setStatus] = useState<CompanionStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  // form drafts
  const [hostname, setHostname] = useState("127.0.0.1");
  const [port, setPort] = useState(12421);
  const [username, setUsername] = useState("opencode");
  const [password, setPassword] = useState("");
  const [cors, setCors] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await rpc.call<CompanionStatus>("companion.status");
      setStatus(res);
      setHostname(res.config.hostname);
      setPort(res.config.port);
      setUsername(res.config.username);
      setPassword(res.config.password);
      setCors(res.config.cors.join(", "));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      const corsArr = cors
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await rpc.call<CompanionStatus>("companion.update", {
        hostname: hostname.trim() || "127.0.0.1",
        port,
        username: username.trim() || "opencode",
        password,
        cors: corsArr,
      });
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const start = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      const corsArr = cors.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await rpc.call<CompanionStatus>("companion.update", {
        enabled: true,
        hostname: hostname.trim() || "127.0.0.1",
        port,
        username: username.trim() || "opencode",
        password,
        cors: corsArr,
      });
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const stop = async (): Promise<void> => {
    setSaving(true);
    try {
      const res = await rpc.call<CompanionStatus>("companion.update", { enabled: false });
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const restart = async (): Promise<void> => {
    setSaving(true);
    try {
      const res = await rpc.call<CompanionStatus>("companion.restart");
      setStatus(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const copyUrl = async (): Promise<void> => {
    if (!status?.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
    } catch {
      setError("Could not copy — select the URL manually.");
    }
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="prov-name">Companion server</span>
        <span className="micro" title="Extension-owned stable HTTP gateway for mobile/Tailscale">
          {status?.running ? `● ${status.url}` : "○ stopped"}
        </span>
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          done
        </button>
      </div>

      {error && <div className="drawer-empty" style={{ color: "var(--oc2-danger)" }}>{error}</div>}

      <div className="drawer-list" style={{ gap: "10px", padding: "12px" }}>
        <div className="oc2-mcp-auth" style={{ gap: "6px" }}>
          {!status?.running ? (
            <button type="button" className="primary" onClick={() => void start()} disabled={saving} title="Save settings and start the gateway">
              ▶ Start
            </button>
          ) : (
            <button type="button" className="danger" onClick={() => void stop()} disabled={saving} title="Stop the gateway">
              ■ Stop
            </button>
          )}
          <button type="button" className="chip" onClick={() => void restart()} disabled={saving || !status?.running} title="Restart gateway">
            ↻ restart
          </button>
          <span className="micro" style={{ opacity: 0.7, marginLeft: "6px" }}>
            {status?.running ? `● running` : "○ stopped"}
          </span>
          <span className="spacer" />
          {status?.url && (
            <>
              <span className="micro" style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={status.url}>
                {status.url}
              </span>
              <button type="button" className="chip" onClick={() => void copyUrl()} title="Copy URL">
                copy
              </button>
            </>
          )}
        </div>

        <div className="menu-section">bind</div>
        <label>
          hostname
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="127.0.0.1 or 0.0.0.0" />
          <span className="micro" style={{ opacity: 0.6 }}>0.0.0.0 = LAN, requires password</span>
        </label>
        <label>
          port
          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 12421)} min={1} max={65535} />
        </label>

        <div className="menu-section">auth</div>
        <label>
          username
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="opencode" />
        </label>
        <label>
          password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="long random value" />
          <span className="micro" style={{ opacity: 0.6 }}>Static — stays same after save. Empty = no auth (only 127.0.0.1).</span>
        </label>

        <button type="button" className="primary" onClick={() => void save()} disabled={saving} title="Save hostname/port/auth without starting/stopping">
          {saving ? "saving…" : "Save settings"}
        </button>

        <details style={{ marginTop: "4px" }}>
          <summary className="micro" style={{ cursor: "pointer", opacity: 0.7 }}>
            Advanced
          </summary>
          <label style={{ marginTop: "8px" }}>
            allowed CORS origins (comma separated)
            <input value={cors} onChange={(e) => setCors(e.target.value)} placeholder="http://localhost:5173" />
            <span className="micro" style={{ opacity: 0.6 }}>Browser-only; native apps ignore CORS.</span>
          </label>
        </details>

        <div className="menu-sep" />
        <div className="menu-section">mobile app</div>
        <div className="drawer-empty" style={{ textAlign: "left" }}>
          App link coming soon — use the URL above with your username/password in the companion app. Served via HTTP+SSE (reliable, no polling) on the fixed port.
        </div>
      </div>
    </div>
  );
}
