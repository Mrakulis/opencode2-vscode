import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isInbound } from "../src/protocol";
import type { ResolvedConfig, SettingKey } from "../src/protocol";
import {
  isAssistant,
  isUser,
  rpc,
  type AnyMessage,
  type SessionSummary,
} from "./lib/rpc";
import { contextPercent, formatCost, formatTokens } from "./lib/format";
import { modelKey, resolveDefault, toggleInList } from "./lib/models";
import { chime } from "./lib/sound";
import { HeaderBar } from "./components/HeaderBar";
import { SessionsDrawer } from "./components/SessionsDrawer";
import { ModelManager } from "./components/ModelManager";
import { ProvidersDrawer } from "./components/ProvidersDrawer";
import { McpDrawer } from "./components/McpDrawer";
import { Feed } from "./components/Feed";
import { Composer } from "./components/Composer";
import { StatusStrip } from "./components/StatusStrip";

type Conn = "connected" | "connecting" | "error";

interface PermissionCardData {
  sessionID: string;
  requestID: string;
  action: string;
  resources: string[];
}

export function App() {
  const [conn, setConn] = useState<Conn>("connecting");
  const [connDetail, setConnDetail] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<AnyMessage[]>([]);
  const [busySessions, setBusySessions] = useState<Record<string, boolean>>({});
  const [permissions, setPermissions] = useState<PermissionCardData[]>([]);
  const [models, setModels] = useState<Array<{ id: string; providerID: string; name: string; context: number; variants?: Array<{ id: string }> }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sounds, setSounds] = useState(true);
  const getInitialConfig = (): ResolvedConfig | undefined => {
    try {
      const el = document.getElementById("oc2-initial-config");
      if (el?.textContent) return JSON.parse(el.textContent) as ResolvedConfig;
    } catch {}
    return undefined;
  };
  const [cfg, setCfg] = useState<ResolvedConfig | undefined>(() => getInitialConfig());
  const [managerOpen, setManagerOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [serverDefault, setServerDefault] = useState<{ id: string; providerID: string; name?: string } | undefined>(
    undefined,
  );

  // Apply the config embedded by the host at render time — ensures settings are checked on extension/reload, not just after hello.
  useEffect(() => {
    if (!cfg) return;
    document.documentElement.dataset.density = cfg.ui.density;
    if (cfg.ui.accentTint) document.documentElement.style.setProperty("--oc2-accent", cfg.ui.accentTint);
    else document.documentElement.style.removeProperty("--oc2-accent");
    setSounds(cfg.ui.sounds);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const active = useMemo(() => sessions.find((s) => s.id === activeId), [sessions, activeId]);
  const busy = activeId ? busySessions[activeId] === true : false;

  // Keep a ref of activeId so push handlers never go stale.
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // ---- data loading --------------------------------------------------------
  const [allProjects, setAllProjects] = useState(false);
  const refreshSessions = useCallback(
    async (all?: boolean) => {
      try {
        const list = await rpc.call<SessionSummary[]>("session.list", { allProjects: all ?? allProjects });
        setSessions(list);
        return list;
      } catch {
        return [];
      }
    },
    [allProjects],
  );

  const refreshMessages = useCallback(async (sessionId: string) => {
    try {
      const list = await rpc.call<AnyMessage[]>("messages.list", { sessionID: sessionId });
      setMessages(list);
    } catch {
      /* transient */
    }
  }, []);

  const refreshPickers = useCallback(async () => {
    try {
      const [m, a, def] = await Promise.all([
        rpc.call<Array<{ id: string; providerID: string; name: string; context: number; variants?: Array<{ id: string }> }>>("models.list"),
        rpc.call<{ id: string; name: string }[]>("agents.list"),
        rpc.call<{ id?: string; providerID?: string; name?: string } | null>("models.default").catch(() => null),
      ]);
      setModels(m);
      setAgents(a);
      if (def?.id && def?.providerID) {
        setServerDefault({ id: def.id, providerID: def.providerID, name: def.name });
      }
    } catch {
      /* not connected yet */
    }
  }, []);

  const refreshPendingPermissions = useCallback(async () => {
    try {
      const pending = (await rpc.call<
        Array<{ data?: { id: string; sessionID: string; action: string; resources?: string[] } }>
      >("permissions.pending")) as unknown as {
        data?: Array<{ id: string; sessionID: string; action: string; resources?: string[] }>;
      };
      const rows = pending.data ?? [];
      setPermissions(
        rows.map((r) => ({
          sessionID: r.sessionID,
          requestID: r.id,
          action: r.action,
          resources: r.resources ?? [],
        })),
      );
    } catch {
      /* transient */
    }
  }, []);

  const selectSession = useCallback(
    (id: string | undefined) => {
      setActiveId(id);
      setMessages([]);
      setPermissions([]);
      if (id) void refreshMessages(id);
    },
    [refreshMessages],
  );

  // ---- push events ---------------------------------------------------------
  useEffect(() => {
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let messageTimer: ReturnType<typeof setTimeout> | undefined;

    const offPush = rpc.onPush((msg) => {
      switch (msg.type) {
        case "ready": {
          setCfg(msg.config);
          document.documentElement.dataset.density = msg.config.ui.density;
          if (msg.config.ui.accentTint) {
            document.documentElement.style.setProperty("--oc2-accent", msg.config.ui.accentTint);
          } else {
            document.documentElement.style.removeProperty("--oc2-accent");
          }
          setSounds(msg.config.ui.sounds);
          break;
        }
        case "connection": {
          setConn(msg.state);
          setConnDetail(msg.detail);
          if (msg.state === "connected") {
            void (async () => {
              const list = await refreshSessions();
              await refreshPickers();
              void refreshPendingPermissions();
              setActiveId((current) => {
                if (!current) {
                  const recent = mostRecentSession(list);
                  if (recent) void refreshMessages(recent.id);
                  return recent?.id;
                }
                return current;
              });
            })();
          }
          break;
        }
        case "resync": {
          void (async () => {
            const list = await refreshSessions();
            await refreshPickers();
            void refreshPendingPermissions();
            setActiveId((current) => {
              if (current) {
                void refreshMessages(current);
                return current;
              }
              const recent = mostRecentSession(list);
              if (recent) void refreshMessages(recent.id);
              return recent?.id;
            });
          })();
          break;
        }
        case "selectSession": {
          selectSession(msg.id);
          setDrawerOpen(false);
          break;
        }
        case "event": {
          const evt = msg.event as { type?: string; data?: { sessionID?: string } } | undefined;
          if (!evt?.type) break;
          const sid = evt.data?.sessionID;

          // Sounds: finish + permission chimes for background sessions only.
          if (sounds && sid && sid !== activeIdRef.current) {
            if (evt.type === "session.execution.succeeded") chime("done");
            if (evt.type === "permission.asked") chime("attention");
          }

          const isTerminal =
            evt.type === "session.execution.succeeded" ||
            evt.type === "session.execution.failed" ||
            evt.type === "session.execution.interrupted";
          if ((isTerminal || evt.type === "session.idle") && sounds && sid === activeIdRef.current) {
            if (isTerminal) chime("done");
          }

          if (
            evt.type.startsWith("session.") ||
            evt.type.startsWith("permission.") ||
            evt.type.startsWith("execution.") ||
            evt.type.startsWith("message.")
          ) {
            clearTimeout(sessionTimer);
            sessionTimer = setTimeout(() => void refreshSessions(), 150);
          }

          if (sid && sid === activeIdRef.current) {
            clearTimeout(messageTimer);
            messageTimer = setTimeout(() => void refreshMessages(sid), 120);
            if (evt.type === "session.execution.started" || evt.type === "session.status.updated") {
              setBusySessions((b) => ({ ...b, [sid]: true }));
            }
            if (
              evt.type === "session.execution.succeeded" ||
              evt.type === "session.execution.failed" ||
              evt.type === "session.execution.interrupted" ||
              evt.type === "session.idle"
            ) {
              setBusySessions((b) => ({ ...b, [sid]: false }));
            }
          }

          if (evt.type === "permission.asked") {
            const data = evt.data as unknown as PermissionCardData | undefined;
            if (data?.sessionID && data.requestID) {
              setPermissions((list) =>
                list.some((p) => p.requestID === data.requestID) ? list : [...list, data],
              );
            }
          }
          break;
        }
      }
    });

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);

    return () => {
      offPush();
      window.removeEventListener("keydown", onKey);
      clearTimeout(sessionTimer);
      clearTimeout(messageTimer);
    };
  }, [refreshSessions, refreshMessages, refreshPickers, refreshPendingPermissions, selectSession, sounds]);

  // Report the visible session so host notifications skip it.
  useEffect(() => {
    if (conn !== "connected") return;
    void rpc.call("ui.activeSession", { id: activeId }).catch(() => undefined);
  }, [activeId, conn]);

  // Keep the feed in sync even if the event stream stalls (fallback poll while busy).
  useEffect(() => {
    if (!busy || !activeId) return;
    const id = setInterval(() => void refreshMessages(activeId), 1500);
    return () => clearInterval(id);
  }, [busy, activeId, refreshMessages]);

  // ---- actions -------------------------------------------------------------
  const sendMessage = useCallback(
    async (text: string, files?: Array<{ uri: string; name?: string }>) => {
      if (!activeId || (!text.trim() && (!files || files.length === 0))) return;
      const optimistic: Extract<AnyMessage, { type: "user" }> = {
        type: "user",
        id: `pending-${Date.now()}`,
        text: text || (files?.length ? `📎 ${files.map((f) => f.name ?? f.uri).join(", ")}` : ""),
        time: { created: Date.now() },
      };
      setMessages((m) => [...m, optimistic]);
      setBusySessions((b) => ({ ...b, [activeId]: true }));
      try {
        const params: Record<string, unknown> = { sessionID: activeId, text: text || "" };
        if (files && files.length) (params as Record<string, unknown>).files = files;
        await rpc.call("prompt.send", params);
      } catch (error) {
        setMessages((m) => m.filter((x) => x.id !== optimistic.id));
        setBusySessions((b) => ({ ...b, [activeId]: false }));
        throw error;
      }
    },
    [activeId],
  );

  const interrupt = useCallback(async () => {
    if (!activeId) return;
    try {
      await rpc.call("prompt.interrupt", { sessionID: activeId });
    } catch {
      /* surfaced by state */
    }
  }, [activeId]);

  const updateSettings = useCallback(async (updates: Array<{ key: SettingKey; value: unknown }>) => {
    try {
      await rpc.call("settings.update", { updates });
      // host pushes the fresh config automatically on settings change
    } catch {
      /* config push will reflect reality */
    }
  }, []);

  const newSession = useCallback(async () => {
    try {
      const def = resolveDefault(cfg?.models.default ?? "", serverDefault);
      const session = await rpc.call<SessionSummary>("session.create", def ? { model: def } : {});
      await refreshSessions();
      selectSession(session.id);
      setDrawerOpen(false);
    } catch {
      /* error toast comes from rpc rejection path */
    }
  }, [cfg, serverDefault, refreshSessions, selectSession]);

  const replyPermission = useCallback(
    async (requestID: string, reply: "once" | "always" | "reject") => {
      const target = permissions.find((p) => p.requestID === requestID);
      setPermissions((list) => list.filter((p) => p.requestID !== requestID));
      if (!target) return;
      try {
        await rpc.call("permission.reply", {
          sessionID: target.sessionID,
          requestID,
          reply,
        });
      } catch {
        /* reappear via next permission.asked */
      }
    },
    [permissions],
  );

  // ---- derived -------------------------------------------------------------
  const lastAssistant = useMemo(() => [...messages].reverse().find(isAssistant), [messages]);
  const effectiveModel =
    (active as unknown as { model?: { id: string; providerID: string; variant?: string } })?.model ??
    lastAssistant?.model ??
    serverDefault ??
    undefined;
  const ctxLimit = useMemo(() => {
    const ref = effectiveModel;
    if (!ref) return undefined;
    const hit = models.find((m) => m.id === ref.id && m.providerID === ref.providerID) as unknown as
      | { context?: number; limit?: { context?: number } }
      | undefined;
    return hit?.context ?? hit?.limit?.context;
  }, [effectiveModel, models]);
  const ctxPct = useMemo(
    () => contextPercent(lastAssistant?.tokens ?? active?.tokens, ctxLimit),
    [lastAssistant, active, ctxLimit],
  );

  const lastAssistantText = useMemo(() => {
    const m = [...messages].reverse().find(isAssistant) as unknown as
      | { content?: Array<{ type: string; text?: string }> }
      | undefined;
    const texts = m?.content?.filter((p) => p.type === "text").map((p) => p.text ?? "") ?? [];
    return texts.join("\n");
  }, [messages]);
  const isQuestion = useMemo(() => {
    if (permissions.length > 0 || !lastAssistantText) return false;
    const t = lastAssistantText.trim();
    return t.includes("?") || /please (confirm|let me know|choose|select)/i.test(t);
  }, [lastAssistantText, permissions]);

  const isPlan = useMemo(() => {
    const id = active?.agent?.toLowerCase() ?? "";
    if (id.includes("plan")) return true;
    const ag = agents.find((a) => a.id === active?.agent);
    return ag?.name?.toLowerCase().includes("plan") ?? false;
  }, [active?.agent, agents]);

  useEffect(() => {
    if (isPlan) {
      document.documentElement.dataset.plan = "true";
      document.documentElement.style.setProperty("--oc2-accent", "#f59e0b");
    } else {
      document.documentElement.dataset.plan = "false";
      if (cfg?.ui.accentTint) document.documentElement.style.setProperty("--oc2-accent", cfg.ui.accentTint);
      else document.documentElement.style.removeProperty("--oc2-accent");
    }
  }, [isPlan, cfg?.ui.accentTint]);

  return (
    <div className="app">
      <div className="busy-bar" data-busy={busy ? "true" : "false"} aria-hidden />
      <HeaderBar
        conn={conn}
        title={active?.title}
        sessionId={activeId}
        workspaceName={
          active?.location?.directory
            ? active.location.directory.split(/[\\/]/).filter(Boolean).pop()
            : undefined
        }
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        onRename={async (title) => {
          if (activeId) await rpc.call("session.rename", { sessionID: activeId, title }).catch(() => undefined);
          void refreshSessions();
        }}
        onOpenManager={() => setManagerOpen(true)}
        onOpenProviders={() => setProvidersOpen(true)}
        onOpenMcp={() => setMcpOpen(true)}
        onOpenSettings={() => void rpc.call("settings.open").catch(() => undefined)}
        onCopyTranscript={async () => {
          const md = buildTranscript(messages);
          try {
            await rpc.call("transcript.copy", { markdown: md });
          } catch {
            /* clipboard unavailable */
          }
        }}
        onFork={async () => {
          if (!activeId) return;
          const forked = await rpc.call<SessionSummary>("session.fork", { sessionID: activeId }).catch(() => undefined);
          if (forked) {
            await refreshSessions();
            selectSession(forked.id);
          }
        }}
        onCompact={async () => {
          if (activeId) await rpc.call("session.compact", { sessionID: activeId }).catch(() => undefined);
        }}
      />

      <main className="feed">
        {conn !== "connected" ? (
          <div className="empty">
            {conn === "connecting" ? (
              <>
                <h2>Connecting…</h2>
                <p>Looking for the OpenCode V2 background service.</p>
              </>
            ) : (
              <>
                <h2>Service unreachable</h2>
                {connDetail && <code className="err-detail">{connDetail}</code>}
                <p>Run “OpenCode 2: Restart Background Service” from the command palette.</p>
              </>
            )}
          </div>
        ) : !activeId ? (
          <div className="empty">
            <h2>No sessions yet</h2>
            <button type="button" className="primary" onClick={() => void newSession()}>
              New session
            </button>
          </div>
        ) : (
          <Feed
            messages={messages}
            busy={busy}
            showReasoning={cfg?.ui.showReasoning ?? "collapsed"}
            expandShellTools={cfg?.ui.expandShellTools ?? false}
            expandEditTools={cfg?.ui.expandEditTools ?? false}
            fullShellOutput={cfg?.ui.fullShellOutput ?? false}
            messageStats={cfg?.ui.messageStats ?? true}
          />
        )}

        {drawerOpen && (
          <SessionsDrawer
            sessions={sessions}
            activeId={activeId}
            allProjects={allProjects}
            onToggleAll={() => {
              const next = !allProjects;
              setAllProjects(next);
              void refreshSessions(next);
            }}
            onSelect={(id) => {
              selectSession(id);
              setDrawerOpen(false);
            }}
            onNew={() => void newSession()}
            onDelete={async (id) => {
              await rpc.call("session.remove", { sessionID: id }).catch(() => undefined);
              if (id === activeId) selectSession(undefined);
              await refreshSessions();
            }}
          />
        )}

        {managerOpen && (
          <ModelManager
            models={models}
            hidden={cfg?.models.hidden ?? []}
            favorites={cfg?.models.favorites ?? []}
            defaultKey={cfg?.models.default ?? ""}
            recents={recents}
            onClose={() => setManagerOpen(false)}
            onUpdate={(updates) => void updateSettings(updates)}
          />
        )}

        {providersOpen && <ProvidersDrawer onClose={() => setProvidersOpen(false)} />}

        {mcpOpen && <McpDrawer onClose={() => setMcpOpen(false)} />}
      </main>

      {permissions.length > 0 && activeId && (
        <div className="permissions">
          {permissions.map((p) => (
            <PermissionRow key={p.requestID} perm={p} onReply={(r) => void replyPermission(p.requestID, r)} />
          ))}
        </div>
      )}

      {isQuestion && permissions.length === 0 && activeId && (
        <div className="permissions">
          <div className="perm-card" data-action="question" style={{ borderLeftColor: "#c084fc" }}>
            <div className="perm-header">
              <span className="perm-badge" style={{ color: "#c084fc", borderColor: "rgba(192,132,252,0.4)" }}>
                question
              </span>
              <span>Agent is waiting for your answer</span>
            </div>
            <div className="perm-hint">Reply in the composer below — it will be sent as the answer. Other agents show this as an inline prompt with quick-reply buttons; we surface it here so it never gets lost in the feed.</div>
          </div>
        </div>
      )}

      <Composer
        disabled={!activeId || conn !== "connected"}
        busy={busy}
        sendKey={cfg?.ui.sendKey ?? "enter"}
        onSend={(t, files) => void sendMessage(t, files)}
        onStop={() => void interrupt()}
        agents={agents}
        activeAgent={active?.agent}
        agentName={agents.find((a) => a.id === active?.agent)?.name}
        models={models}
        hidden={cfg?.models.hidden ?? []}
        favorites={cfg?.models.favorites ?? []}
        defaultKey={cfg?.models.default ?? ""}
        recents={recents}
        activeModel={effectiveModel}
        onPickModel={async (m) => {
          const key = modelKey(m);
          setRecents((r) => [key, ...r.filter((k) => k !== key)].slice(0, 5));
          if (activeId) {
            setSessions((prev) =>
              prev.map((s) => (s.id === activeId ? ({ ...s, model: { id: m.id, providerID: m.providerID } } as SessionSummary) : s)),
            );
            await rpc.call("model.switch", { sessionID: activeId, model: m }).catch(() => undefined);
          }
          void refreshSessions();
        }}
        onPickVariant={async (variant) => {
          const am = effectiveModel;
          if (activeId && am) {
            const nextModel = variant
              ? { id: am.id, providerID: am.providerID, variant }
              : { id: am.id, providerID: am.providerID };
            setSessions((prev) =>
              prev.map((s) => (s.id === activeId ? ({ ...s, model: nextModel } as SessionSummary) : s)),
            );
            await rpc.call("model.switch", {
              sessionID: activeId,
              model: { id: am.id, providerID: am.providerID, variant },
            }).catch(() => undefined);
          }
          void refreshSessions();
        }}
        onPickAgent={async (a) => {
          if (activeId) {
            await rpc.call("agent.switch", { sessionID: activeId, agent: a }).catch(() => undefined);
          }
          void refreshSessions();
        }}
        onToggleFavorite={(key) =>
          void updateSettings([{ key: "models.favorites", value: toggleInList(cfg?.models.favorites ?? [], key) }])
        }
        onOpenManager={() => setManagerOpen(true)}
      />

      {conn === "connected" && <StatusStrip connected cost={active?.cost} tokens={active?.tokens} ctxPct={ctxPct} ctxLimit={ctxLimit} />}
    </div>
  );
}

function PermissionRow({
  perm,
  onReply,
}: {
  perm: PermissionCardData;
  onReply: (reply: "once" | "always" | "reject") => void;
}) {
  const kind = perm.action.toLowerCase().includes("shell")
    ? "shell"
    : perm.action.toLowerCase().includes("edit") || perm.action.toLowerCase().includes("write")
      ? "edit"
      : perm.action.toLowerCase().includes("read")
        ? "read"
        : "other";
  return (
    <div className="perm-card" data-action={perm.action.toLowerCase().includes("shell") ? "shell" : perm.action.toLowerCase().includes("edit") ? "edit" : perm.action.toLowerCase().includes("read") ? "read" : "other"}>
      <div className="perm-header">
        <span className={`perm-badge ${kind}`}>{perm.action}</span>
        <span>Permission required</span>
      </div>
      {perm.resources.length > 0 ? (
        <div className="perm-resources">
          {perm.resources.map((r, i) => (
            <code key={i} className="perm-res">
              {r}
            </code>
          ))}
        </div>
      ) : (
        <div className="perm-hint">Agent wants to perform this action.</div>
      )}
      <div className="perm-actions">
        <button type="button" className="primary" onClick={() => onReply("once")} title="Allow this time (Enter)">
          Allow once
        </button>
        <button type="button" onClick={() => onReply("always")} title="Always allow this action/resource">
          Always allow
        </button>
        <button type="button" className="danger" onClick={() => onReply("reject")} title="Deny (Esc)">
          Deny
        </button>
      </div>
    </div>
  );
}

function mostRecentSession(list: SessionSummary[]): SessionSummary | undefined {
  return [...list].sort((a, b) => b.time.updated - a.time.updated)[0];
}

/** Render the visible conversation as markdown for clipboard export. */
function buildTranscript(messages: AnyMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (isUser(m)) {
      lines.push(`## 🧑 Prompt\n\n${m.text}\n`);
    } else if (isAssistant(m)) {
      lines.push(`## 🤖 ${m.agent}${m.model ? ` (${m.model.providerID}/${m.model.id})` : ""}\n`);
      for (const part of m.content ?? []) {
        if (part.type === "text") lines.push(`${part.text}\n`);
        if (part.type === "reasoning") lines.push(`> _thinking:_ ${truncate(part.text, 400)}\n`);
      }
      if (m.cost !== undefined) lines.push(`_cost: ${formatCost(m.cost)} · ${formatTokens(m.tokens?.input)} in / ${formatTokens(m.tokens?.output)} out_\n`);
    }
  }
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
