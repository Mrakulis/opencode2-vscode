import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedConfig, SettingKey, WireForm } from "../src/protocol";
import { THEME_IDS } from "../src/protocol";
import type { SlashEntry } from "./lib/slash";
import {
  isAssistant,
  isUser,
  rpc,
  type AnyMessage,
  type SessionSummary,
} from "./lib/rpc";
import {
  contextPercent,
  formatCost,
  formatTokens,
  liveContextStepTokens,
} from "./lib/format";
import { modelKey, resolveDefault, toggleInList } from "./lib/models";
import { chime } from "./lib/sound";
import { actionsForEvent } from "./lib/events";
import { applyDelta, type DeltaEvent } from "./lib/deltas";
import {
  autoReplyFor,
  RespondedTracker,
} from "./lib/permissions";
import { HeaderBar } from "./components/HeaderBar";
import { SessionsDrawer } from "./components/SessionsDrawer";
import { ModelManager } from "./components/ModelManager";
import { ProvidersDrawer } from "./components/ProvidersDrawer";
import { McpDrawer } from "./components/McpDrawer";
import { Feed } from "./components/Feed";
import { FormCard } from "./components/FormCard";
import { SavedPermissionsDrawer } from "./components/SavedPermissionsDrawer";
import { InstructionsDrawer } from "./components/InstructionsDrawer";
import { WorktreesDrawer } from "./components/WorktreesDrawer";
import { InboxDrawer } from "./components/InboxDrawer";
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
  const [forms, setForms] = useState<WireForm[]>([]);
  const [mcpTick, setMcpTick] = useState(0);
  const [providersTick, setProvidersTick] = useState(0);
  const [worktreeTick, setWorktreeTick] = useState(0);
  const [instructionsTick, setInstructionsTick] = useState(0);
  const [slashTick, setSlashTick] = useState(0);
  const [vcsBranch, setVcsBranch] = useState<string | undefined>(undefined);
  /** Transient error from overflow-menu actions (import/export/undo…). */
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  /** Mirror of `messages` so event handlers can merge deltas without stale closures. */
  const messagesRef = useRef<AnyMessage[]>([]);
  /** Last message reverted from (so Redo can distinguish itself from Undo). */
  const revertTargetRef = useRef<string | undefined>(undefined);
  const [connDetail, setConnDetail] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<AnyMessage[]>([]);
  const [retryPending, setRetryPending] = useState(false);
  /** Full streamed text per `${messageId}|${kind}` — survives refetches. */
  const deltaAccRef = useRef(new Map<string, string>());
  const [busySessions, setBusySessions] = useState<Record<string, boolean>>({});
  const [permissions, setPermissions] = useState<PermissionCardData[]>([]);
  const [models, setModels] = useState<
    Array<{
      id: string;
      providerID: string;
      name: string;
      context: number;
      variants?: Array<{ id: string }>;
    }>
  >([]);
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
  const [cfg, setCfg] = useState<ResolvedConfig | undefined>(() =>
    getInitialConfig(),
  );
  const [managerOpen, setManagerOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [savedPermsOpen, setSavedPermsOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [serverDefault, setServerDefault] = useState<
    { id: string; providerID: string; name?: string } | undefined
  >(undefined);
  const permissionMode = cfg?.permissions.mode ?? "askFirst";

  // Apply the config embedded by the host at render time — ensures settings are checked on extension/reload, not just after hello.
  useEffect(() => {
    if (!cfg) return;
    document.documentElement.dataset.density = cfg.ui.density;
    document.documentElement.dataset.theme = cfg.ui.theme;
    if (cfg.ui.accentTint)
      document.documentElement.style.setProperty(
        "--oc2-accent",
        cfg.ui.accentTint,
      );
    else document.documentElement.style.removeProperty("--oc2-accent");
    setSounds(cfg.ui.sounds);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId),
    [sessions, activeId],
  );
  const busy = activeId ? busySessions[activeId] === true : false;

  /** Server-driven auto-retry state (SessionRetry) for visibility. */
  const [retryInfo, setRetryInfo] = useState<
    | { attempt?: number; message?: string; action?: { title?: string; message?: string; label?: string; link?: string } }
    | undefined
  >(undefined);

  /** Dismissible error banner — the webview has no other toast surface. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Last model the user actually used (persisted host-side in workspaceState). */
  const [lastUsedModel, setLastUsedModel] = useState<
    { id: string; providerID: string } | undefined
  >(undefined);

  // Session auto-accept + dedupe tracker (OpenCode permission parity).
  const autoAcceptSessionsRef = useRef(new Set<string>());
  const respondedRef = useRef(new RespondedTracker());

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
        const list = await rpc.call<SessionSummary[]>("session.list", {
          allProjects: all ?? allProjects,
        });
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
      const list = await rpc.call<AnyMessage[]>("messages.list", {
        sessionID: sessionId,
      });
      // While reasoning/text is streaming, the REST snapshot lags the deltas we
      // accumulate in messagesRef (the server finalizes parts only at the end),
      // so a mid-stream refetch could wipe the thinking shown so far. Overlay:
      // keep the *longer* local text for text/reasoning parts — deltas only grow.
      const localById = new Map<string, AnyMessage>();
      for (const m of messagesRef.current) {
        const id = (m as { id?: unknown }).id;
        if (typeof id === "string") localById.set(id, m);
      }
      const merged: AnyMessage[] = list.map((m) => {
        const mm = m as unknown as {
          id?: string;
          type?: string;
          content?: Array<Record<string, unknown>>;
        };
        if (mm.type !== "assistant" || !Array.isArray(mm.content)) return m;
        const lm = localById.get((m as { id?: string }).id ?? "") as unknown as
          | { type?: string; content?: Array<Record<string, unknown>> }
          | undefined;
        if (!lm || lm.type !== "assistant" || !Array.isArray(lm.content)) return m;
        const localParts = new Map<string, string>();
        for (const p of lm.content) {
          if (
            (p.type === "text" || p.type === "reasoning") &&
            typeof p.text === "string"
          ) {
            localParts.set(p.type, p.text);
          }
        }
        // Fold in the delta accumulator: it holds every streamed chunk even
        // when the snapshot hasn't caught up yet.
        const msgId = (m as { id?: string }).id ?? "";
        for (const kind of ["text", "reasoning"]) {
          const acc = deltaAccRef.current.get(`${msgId}|${kind}`);
          if (acc && acc.length > (localParts.get(kind) ?? "").length) {
            localParts.set(kind, acc);
          }
        }
        let changed = false;
        const content = mm.content.map((p) => {
          if (
            (p.type === "text" || p.type === "reasoning") &&
            typeof p.text === "string"
          ) {
            const localText = localParts.get(p.type) ?? "";
            if (localText.length > p.text.length) {
              changed = true;
              return { ...p, text: localText };
            }
          }
          // Streamed SHELL OUTPUT lives in tool.state.content — protect it
          // from snapshots that arrive with the tool truncated/empty.
          if (p.type === "tool") {
            const toolId = typeof p.id === "string" ? p.id : undefined;
            const localTool =
              toolId != null && Array.isArray(lm.content)
                ? lm.content.find(
                    (lp) =>
                      lp.type === "tool" &&
                      (lp as { id?: unknown }).id === toolId,
                  )
                : undefined;
            const len = (c?: unknown): number => {
              const st = (c as { state?: { content?: unknown[] } } | undefined)
                ?.state;
              const arr = Array.isArray(st?.content) ? st!.content : [];
              let n = 0;
              for (const blk of arr) {
                const t = (blk as { text?: unknown }).text;
                if (typeof t === "string") n += t.length;
              }
              return n;
            };
            const localLen = len(localTool);
            if (localTool && localLen > len(p)) {
              changed = true;
              return localTool;
            }
          }
          return p;
        });
        if (!changed) return m;
        return {
          ...(m as unknown as Record<string, unknown>),
          content,
        } as unknown as AnyMessage;
      });
      setMessages(merged);
    } catch {
      /* transient */
    }
  }, []);

  const refreshPickers = useCallback(async () => {
    // Per-call catches: one drifted endpoint must not blank the other pickers.
    const [m, a, def] = await Promise.all([
      rpc
        .call<
          Array<{
            id: string;
            providerID: string;
            name: string;
            context: number;
            variants?: Array<{ id: string }>;
          }>
        >("models.list")
        .catch((e: unknown) => {
          console.warn("[oc2] models.list failed", e);
          return undefined;
        }),
      rpc
        .call<{ id: string; name: string }[]>("agents.list")
        .catch((e: unknown) => {
          console.warn("[oc2] agents.list failed", e);
          return undefined;
        }),
      rpc
        .call<{ id?: string; providerID?: string; name?: string } | null>(
          "models.default",
        )
        .catch(() => null),
    ]);
    if (m) setModels(m);
    if (a) setAgents(a);
    if (def?.id && def?.providerID) {
      setServerDefault({
        id: def.id,
        providerID: def.providerID,
        name: def.name,
      });
    }
  }, []);

  const refreshPendingPermissions = useCallback(async () => {
    try {
      const pending = (await rpc.call<
        Array<{
          data?: {
            id: string;
            sessionID: string;
            action: string;
            resources?: string[];
          };
        }>
      >("permissions.pending")) as unknown as {
        data?: Array<{
          id: string;
          sessionID: string;
          action: string;
          resources?: string[];
        }>;
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
      setForms((list) => (id ? list.filter((f) => f.sessionID === id) : []));
      if (id) void refreshMessages(id);
    },
    [refreshMessages],
  );

  /** Re-fetch pending agent form requests (all sessions; UI filters by visibility). */
  const refreshForms = useCallback(async () => {
    try {
      const rows =
        await rpc.call<Array<Record<string, unknown>>>("forms.pending");
      const wires = rows
        .map(toWireFormClient)
        .filter((f): f is WireForm => f !== undefined);
      setForms(wires);
    } catch {
      /* transient */
    }
  }, []);

  const refreshVcs = useCallback(async () => {
    try {
      const info = await rpc.call<{ branch?: string } | undefined>("vcs.info");
      setVcsBranch(info?.branch || undefined);
    } catch {
      setVcsBranch(undefined);
    }
  }, []);

  const reloadSlash = useCallback(async () => {
    setSlashTick((t) => t + 1);
  }, []);

  // Keep messagesRef in sync for the delta accumulator.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Restore the last-used model once per webview load.
  useEffect(() => {
    rpc
      .call<{ id: string; providerID: string } | undefined>("ui.lastModel")
      .then((m) => {
        if (m?.id && m.providerID) setLastUsedModel(m);
      })
      .catch(() => undefined);
  }, []);

  // Branch chip: fetch once per connection + on vcs events.
  useEffect(() => {
    if (conn === "connected") void refreshVcs();
  }, [conn, refreshVcs]);

  // ---- push events ---------------------------------------------------------
  useEffect(() => {
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let messageTimer: ReturnType<typeof setTimeout> | undefined;

    const offPush = rpc.onPush((msg) => {
      switch (msg.type) {
        case "ready": {
          setCfg(msg.config);
          document.documentElement.dataset.density = msg.config.ui.density;
          document.documentElement.dataset.theme = msg.config.ui.theme;
          if (msg.config.ui.accentTint) {
            document.documentElement.style.setProperty(
              "--oc2-accent",
              msg.config.ui.accentTint,
            );
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
            // Fresh connection: stale failure state must not linger.
            setRetryPending(false);
            setRetryInfo(undefined);
            void (async () => {
              const list = await refreshSessions();
              await refreshPickers();
              void refreshPendingPermissions();
              void refreshForms();
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
            void refreshForms();
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
        case "form": {
          setForms((list) =>
            list.some((f) => f.id === msg.form.id) ? list : [...list, msg.form],
          );
          break;
        }
        case "event": {
          const evt = msg.event as
            { type?: string; data?: { sessionID?: string } } | undefined;
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
          if (
            (isTerminal || evt.type === "session.idle") &&
            sounds &&
            sid === activeIdRef.current
          ) {
            if (isTerminal) chime("done");
          }

          // ---- typed event router (Q18: every valuable V2 event wired) ----
          const actions = actionsForEvent(evt.type);
          if (actions.length > 0) {
            // Deltas are applied immediately below (no refetch); everything else
            // refreshes through the debounced REST path.
            clearTimeout(sessionTimer);
            sessionTimer = setTimeout(() => {
              for (const a of actions) {
                if (a === "sessions") void refreshSessions();
                if (a === "pickers") void refreshPickers();
                if (a === "permissions") void refreshPendingPermissions();
                if (a === "forms") void refreshForms();
                if (a === "mcp") setMcpTick((t) => t + 1);
                if (a === "providers") setProvidersTick((t) => t + 1);
                if (a === "vcs") void refreshVcs();
                if (a === "worktrees") setWorktreeTick((t) => t + 1);
                if (a === "instructions") setInstructionsTick((t) => t + 1);
                if (a === "commands") void reloadSlash();
              }
            }, 150);
          }

          if (sid && sid === activeIdRef.current) {
            const wantsMessages = actions.includes("messages");
            const isDelta =
              evt.type === "session.text.delta" ||
              evt.type === "session.reasoning.delta";

            // ALWAYS accumulate deltas — including chunks that arrive before
            // the assistant message exists in our cache. Dropping those is
            // what used to lose the start of the thinking.
            if (isDelta) {
              const d = evt.data as DeltaEvent["data"];
              const id = d?.assistantMessageID ?? d?.messageID;
              const chunk =
                typeof d?.delta === "string"
                  ? d.delta
                  : typeof d?.text === "string"
                    ? d.text
                    : undefined;
              if (id && chunk) {
                const kind = evt.type === "session.reasoning.delta" ? "reasoning" : "text";
                const key = `${id}|${kind}`;
                deltaAccRef.current.set(key, (deltaAccRef.current.get(key) ?? "") + chunk);
              }
            }

            // Try the incremental accumulator first for a smooth stream.
            const merged = applyDelta(messagesRef.current, {
              type: evt.type,
              data: evt.data as DeltaEvent["data"],
            });
            if (merged) {
              messagesRef.current = merged;
              setMessages(merged);
            } else if (wantsMessages || isTerminal || isDelta) {
              clearTimeout(messageTimer);
              messageTimer = setTimeout(
                () => void refreshMessages(sid),
                isDelta ? 80 : 120,
              );
            }
            if (
              evt.type === "session.execution.started" ||
              evt.type === "session.status.updated" ||
              evt.type === "session.status"
            ) {
              setBusySessions((b) => ({ ...b, [sid]: true }));
            }
            // Server-driven auto-retry (SessionRetry) visibility.
            if (evt.type === "session.retry.scheduled") {
              const d = evt.data as
                | { attempt?: number; error?: { message?: string } }
                | undefined;
              setBusySessions((b) => ({ ...b, [sid]: true }));
              setRetryInfo({ attempt: d?.attempt ?? 1, message: d?.error?.message });
              setRetryPending(false);
            }
            if (evt.type === "session.status") {
              const st = (
                evt.data as {
                  status?: {
                    type?: string;
                    attempt?: number;
                    message?: string;
                    action?: {
                      title?: string;
                      message?: string;
                      label?: string;
                      link?: string;
                    };
                  };
                }
              | undefined
              )?.status;
              if (st?.type === "retry") {
                setBusySessions((b) => ({ ...b, [sid]: true }));
                setRetryInfo({
                  attempt: st.attempt ?? 1,
                  message: st.message,
                  ...(st.action ? { action: st.action } : {}),
                });
                setRetryPending(false);
              } else if (st?.type === "idle") {
                setRetryInfo(undefined);
              }
            }
            if (
              evt.type === "session.execution.succeeded" ||
              evt.type === "session.execution.failed" ||
              evt.type === "session.execution.interrupted" ||
              evt.type === "session.idle"
            ) {
              setBusySessions((b) => ({ ...b, [sid]: false }));
              setRetryInfo(undefined);
              if (evt.type === "session.execution.failed") setRetryPending(true);
              else setRetryPending(false);
            }
            // Compaction progress pill.
            if (evt.type === "session.compaction.started")
              setCompacting(true);
            if (
              evt.type === "session.compaction.ended" ||
              evt.type === "session.compaction.failed"
            )
              setCompacting(false);
          }

          if (evt.type === "permission.asked") {
            const data = evt.data as unknown as
              | (PermissionCardData & { id?: string })
              | undefined;
            // SDK field is `id`; tolerate `requestID` for older betas.
            const requestID = data?.id ?? data?.requestID;
            if (data?.sessionID && requestID) {
              setPermissions((list) =>
                list.some((p) => p.requestID === requestID)
                  ? list
                  : [...list, { ...data, requestID }],
              );
            }
          }

          // Forms resolve server-side; drop them when answered/cancelled.
          if (evt.type === "form.replied" || evt.type === "form.cancelled") {
            const fid = (evt.data as { id?: string } | undefined)?.id;
            if (fid) setForms((list) => list.filter((f) => f.id !== fid));
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
  }, [
    refreshSessions,
    refreshMessages,
    refreshPickers,
    refreshPendingPermissions,
    refreshForms,
    selectSession,
    sounds,
  ]);

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

  // Derive server auto-retry state from the latest assistant message too — the
  // `retry: { attempt, at, error }` field survives REST snapshots, so even if
  // an event was missed the retry pill still appears while the run is alive.
  useEffect(() => {
    if (!busy || !activeId) return;
    const last = [...messages].reverse().find(isAssistant);
    const r = (
      last as unknown as
        | { retry?: { attempt?: number; error?: { message?: string } } }
        | undefined
    )?.retry;
    if (r?.attempt) {
      setRetryInfo((prev) => ({
        ...(prev ?? {}),
        attempt: r.attempt,
        message: r.error?.message ?? prev?.message,
      }));
    }
  }, [messages, busy, activeId]);

  // ---- actions -------------------------------------------------------------
  const sendMessage = useCallback(
    async (
      text: string,
      files?: Array<{ uri: string; name?: string }>,
      delivery?: "steer" | "queue",
    ) => {
      if (!activeId || (!text.trim() && (!files || files.length === 0))) return;
      const optimistic: Extract<AnyMessage, { type: "user" }> = {
        type: "user",
        id: `pending-${Date.now()}`,
        text:
          text ||
          (files?.length
            ? `📎 ${files.map((f) => f.name ?? f.uri).join(", ")}`
            : ""),
        time: { created: Date.now() },
      };
      setMessages((m) => [...m, optimistic]);
      setBusySessions((b) => ({ ...b, [activeId]: true }));
      setRetryInfo(undefined); // a fresh run must not inherit stale retry state
      try {
        const params: Record<string, unknown> = {
          sessionID: activeId,
          text: text || "",
        };
        if (files && files.length)
          (params as Record<string, unknown>).files = files;
        if (delivery) params.delivery = delivery;
        await rpc.call("prompt.send", params);
        setRetryPending(false);
        // Track the last-used model (client-side; server defaults are static).
        const used = effectiveModelRef.current;
        if (used) {
          setLastUsedModel(used);
          void rpc
            .call("ui.lastModel.set", { id: used.id, providerID: used.providerID })
            .catch(() => undefined);
        }
      } catch (error) {
        setMessages((m) => m.filter((x) => x.id !== optimistic.id));
        setBusySessions((b) => ({ ...b, [activeId]: false }));
        // Surface a Retry affordance for transport/API failures.
        setRetryPending(true);
        throw error;
      }
    },
    [activeId],
  );

  /** Resend the last user prompt — the recovery path after an API error. */
  const retryLast = useCallback(async () => {
    if (!activeId) return;
    const last = [...messagesRef.current].reverse().find(isUser);
    if (!last) return;
    const files: Array<{ uri: string; name?: string }> | undefined = (() => {
      const raw = (last as { files?: unknown }).files;
      if (!Array.isArray(raw)) return undefined;
      const clean: Array<{ uri: string; name?: string }> = [];
      for (const f of raw as Array<Record<string, unknown>>) {
        if (typeof f?.uri === "string") {
          clean.push({ uri: f.uri, name: typeof f.name === "string" ? f.name : undefined });
        }
      }
      return clean.length > 0 ? clean : undefined;
    })();
    try {
      await sendMessage(last.text, files && files.length > 0 ? files : undefined);
    } catch {
      /* composer/props surface the error; retryPending stays set */
    }
  }, [activeId, sendMessage]);

  const interrupt = useCallback(async () => {
    if (!activeId) return;
    try {
      await rpc.call("prompt.interrupt", { sessionID: activeId });
    } catch {
      /* surfaced by state */
    }
  }, [activeId]);

  const updateSettings = useCallback(
    async (updates: Array<{ key: SettingKey; value: unknown }>) => {
      try {
        await rpc.call("settings.update", { updates });
        // host pushes the fresh config automatically on settings change
      } catch {
        /* config push will reflect reality */
      }
    },
    [],
  );

  const newSession = useCallback(async () => {
    try {
      // Defaults: last-used model wins; agent is always Build for new sessions.
      const def = resolveDefault(
        lastUsedModel,
        cfg?.models.default ?? "",
        serverDefault,
      );
      const session = await rpc.call<SessionSummary>("session.create", {
        agent: "build",
        ...(def ? { model: def } : {}),
      });
      if (!session?.id) throw new Error("server returned no session id");
      await refreshSessions();
      // Optimistic insert in case the directory filter would exclude it.
      setSessions((prev) =>
        prev.some((s) => s.id === session.id)
          ? prev
          : [session as SessionSummary, ...prev],
      );
      selectSession(session.id);
      setDrawerOpen(false);
      setNotice(null);
    } catch (error) {
      console.warn("[oc2] session.create failed", error);
      setNotice(
        `Couldn't create session — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, [cfg, serverDefault, lastUsedModel, refreshSessions, selectSession]);

  /** Export the session in V2 transfer format (JSON, re-importable). */
  const exportSession = useCallback(async () => {
    if (!activeId) return;
    try {
      const data = await rpc.call<unknown>("session.export", {
        sessionID: activeId,
      });
      const res = await rpc.call<{ saved: boolean; path?: string }>(
        "dialog.saveText",
        {
          content: JSON.stringify(data, null, 2),
          suggestedName: `${(active?.title ?? "session").replace(/[^\w.-]+/g, "_")}.json`,
        },
      );
      if (!res.saved && res.path === undefined) return; // user cancelled
    } catch (e) {
      console.warn("[oc2] session.export failed", e);
      setNotice(
        `Couldn't export session — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [activeId, active?.title]);

  /** Undo the last turn: stage a revert at the newest assistant message + commit. */
  const undoLastTurn = useCallback(async () => {
    if (!activeId) return;
    const lastAssistant = [...messagesRef.current].reverse().find(isAssistant);
    if (!lastAssistant) return;
    try {
      await rpc.call("session.revert.stage", {
        sessionID: activeId,
        messageID: lastAssistant.id,
        files: true,
      });
      await rpc.call("session.revert.commit", { sessionID: activeId });
      revertTargetRef.current = lastAssistant.id;
    } catch {
      /* surfaced via refresh */
    }
  }, [activeId]);

  /**
   * Redo: restore to the most recent snapshot after an undo — stage + commit at
   * the latest assistant message again.
   */
  const redoRevert = useCallback(async () => {
    if (!activeId) return;
    const lastAssistant = [...messagesRef.current].reverse().find(isAssistant);
    if (!lastAssistant || lastAssistant.id === revertTargetRef.current) return;
    try {
      await rpc.call("session.revert.stage", {
        sessionID: activeId,
        messageID: lastAssistant.id,
        files: true,
      });
      await rpc.call("session.revert.commit", { sessionID: activeId });
    } catch {
      /* surfaced via refresh */
    }
  }, [activeId]);

  /** Import a previously exported V2 session transfer file (JSON). */
  const importSessionFile = useCallback(async () => {
    try {
      const text = await rpc.call<string | undefined>("dialog.openText", {
        filters: { "OpenCode session export": ["json"] },
      });
      if (!text) return; // cancelled
      const payload = JSON.parse(text) as unknown;
      const created = await rpc.call<{ id: string }>("session.import", {
        payload,
      });
      await refreshSessions();
      if (created?.id) selectSession(created.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setActionError(undefined), 5000);
    }
  }, [refreshSessions, selectSession]);

  /** Open the VCS working-tree diff (from the OpenCode server, not just git). */
  const openWorkingDiff = useCallback(async () => {
    try {
      const diff = await rpc.call<string>("vcs.diff", { mode: "working" });
      await rpc.call("diff.open", {
        file: "working-tree",
        diff: diff || "(no changes)",
      });
    } catch {
      /* surfaced by state */
    }
  }, []);

  const cycleTheme = useCallback(() => {
    const current = cfg?.ui.theme ?? "dark";
    const idx = THEME_IDS.indexOf(current as (typeof THEME_IDS)[number]);
    const next = THEME_IDS[(idx + 1) % THEME_IDS.length] ?? "dark";
    void updateSettings([{ key: "ui.theme", value: next }]);
  }, [cfg?.ui.theme, updateSettings]);

  /** Client-side builtins surfaced in the slash menu — the official apps
   * hard-code these; the V2 API does not serve them. Each maps to a real
   * GUI action that already exists here. */
  const slashBuiltins = useMemo<SlashEntry[]>(
    () => [
      {
        kind: "command",
        name: "new",
        description: "Start a new session",
        local: true,
        run: () => void newSession(),
      },
      {
        kind: "command",
        name: "sessions",
        description: "Open the sessions drawer",
        local: true,
        run: () => setDrawerOpen(true),
      },
      {
        kind: "command",
        name: "models",
        description: "Open the model manager",
        local: true,
        run: () => setManagerOpen(true),
      },
      {
        kind: "command",
        name: "compact",
        description: "Compact the current session",
        local: true,
        run: () => {
          if (activeId)
            void rpc
              .call("session.compact", { sessionID: activeId })
              .catch(() => undefined);
        },
      },
      {
        kind: "command",
        name: "undo",
        description: "Undo last turn + revert files",
        local: true,
        run: () => void undoLastTurn(),
      },
      {
        kind: "command",
        name: "redo",
        description: "Redo the reverted turn",
        local: true,
        run: () => void redoRevert(),
      },
      {
        kind: "command",
        name: "export",
        description: "Export session as JSON",
        local: true,
        run: () => void exportSession(),
      },
      {
        kind: "command",
        name: "import",
        description: "Import a session export",
        local: true,
        run: () => void importSessionFile(),
      },
      {
        kind: "command",
        name: "thinking",
        description:
          "Cycle reasoning visibility (hidden → collapsed → expanded)",
        local: true,
        run: () => {
          const order = ["hide", "collapsed", "expanded"] as const;
          const cur = cfg?.ui.showReasoning ?? "collapsed";
          const next = order[(order.indexOf(cur) + 1) % order.length]!;
          void updateSettings([{ key: "ui.showReasoning", value: next }]);
        },
      },
      {
        kind: "command",
        name: "themes",
        description: `Cycle theme (current: ${cfg?.ui.theme ?? "dark"})`,
        local: true,
        run: cycleTheme,
      },
      {
        kind: "command",
        name: "retry",
        description: "Resend the last prompt (e.g. after an API error)",
        local: true,
        run: () => void retryLast(),
      },
    ],
    [
      newSession,
      activeId,
      undoLastTurn,
      redoRevert,
      exportSession,
      importSessionFile,
      retryLast,
      cfg?.ui.showReasoning,
      cfg?.ui.theme,
      updateSettings,
      cycleTheme,
    ],
  );

  const replyPermission = useCallback(
    async (
      requestID: string,
      reply: "once" | "always" | "reject",
    ): Promise<boolean> => {
      const target = permissions.find((p) => p.requestID === requestID);
      setPermissions((list) => list.filter((p) => p.requestID !== requestID));
      if (!target) return false;
      try {
        await rpc.call("permission.reply", {
          sessionID: target.sessionID,
          requestID,
          reply,
        });
        return true;
      } catch {
        // reappear via next permission.asked; allow a future retry
        respondedRef.current.clear(requestID);
        return false;
      }
    },
    [permissions],
  );

  // Keep the active session auto-accepting in `autoAllow` mode (per-session,
  // mirroring upstream's session/directory auto-accept map).
  useEffect(() => {
    if (!activeId) return;
    if (permissionMode === "autoAllow") autoAcceptSessionsRef.current.add(activeId);
    else autoAcceptSessionsRef.current.delete(activeId);
  }, [activeId, permissionMode]);

  // Auto-decide like OpenCode's session auto-accept: reply when the mode (or an
  // auto-accepting session) says so, deduped against duplicate asks.
  useEffect(() => {
    if (permissions.length === 0) return;
    for (const p of permissions) {
      const reply = autoReplyFor(
        permissionMode,
        p.action,
        autoAcceptSessionsRef.current.has(p.sessionID),
      );
      if (!reply) continue;
      if (respondedRef.current.had(p.requestID)) continue;
      respondedRef.current.mark(p.requestID);
      void replyPermission(p.requestID, reply).then((ok) => {
        if (!ok) respondedRef.current.clear(p.requestID);
      });
    }
  }, [permissions, permissionMode, replyPermission]);

  // Drain already-pending requests when auto mode is enabled (like upstream's
  // enable() which lists + auto-responds pending permissions).
  useEffect(() => {
    if (permissionMode === "askFirst") return;
    const t = setTimeout(() => void refreshPendingPermissions(), 0);
    return () => clearTimeout(t);
  }, [permissionMode, refreshPendingPermissions]);

  // ---- derived -------------------------------------------------------------
  const lastAssistant = useMemo(
    () => [...messages].reverse().find(isAssistant),
    [messages],
  );
  const effectiveModel =
    (
      active as unknown as {
        model?: { id: string; providerID: string; variant?: string };
      }
    )?.model ??
    lastAssistant?.model ??
    serverDefault ??
    undefined;
  const ctxLimit = useMemo(() => {
    const ref = effectiveModel;
    if (!ref) return undefined;
    const hit = models.find(
      (m) => m.id === ref.id && m.providerID === ref.providerID,
    ) as unknown as
      { context?: number; limit?: { context?: number } } | undefined;
    return hit?.context ?? hit?.limit?.context;
  }, [effectiveModel, models]);
  const ctxPct = useMemo(
    // Step snapshots only: session-level tokens are cumulative lifetime usage
    // (they survive compaction and would peg the meter at 100). Steps newer
    // than the newest compaction checkpoint approximate the live window;
    // right after compacting there is none yet, so the meter honestly hides.
    () => contextPercent(liveContextStepTokens(messages), ctxLimit),
    [messages, ctxLimit],
  );
  // Ref mirror so send-time callbacks can read it without dep churn.
  const effectiveModelRef = useRef<
    { id: string; providerID: string } | undefined
  >(undefined);
  useEffect(() => {
    effectiveModelRef.current = effectiveModel
      ? { id: effectiveModel.id, providerID: effectiveModel.providerID }
      : undefined;
  }, [effectiveModel]);

  const isPlan = useMemo(() => {
    const id = active?.agent?.toLowerCase() ?? "";
    if (id.includes("plan")) return true;
    const ag = agents.find((a) => a.id === active?.agent);
    return ag?.name?.toLowerCase().includes("plan") ?? false;
  }, [active?.agent, agents]);

  useEffect(() => {
    // CSS owns the plan accent via [data-plan="true"]; JS only manages accentTint.
    document.documentElement.dataset.plan = isPlan ? "true" : "false";
    if (!isPlan) {
      if (cfg?.ui.accentTint)
        document.documentElement.style.setProperty(
          "--oc2-accent",
          cfg.ui.accentTint,
        );
      else document.documentElement.style.removeProperty("--oc2-accent");
    }
  }, [isPlan, cfg?.ui.accentTint]);

  return (
    <div className="app">
      <div
        className="busy-bar"
        data-busy={busy ? "true" : "false"}
        aria-hidden
      />
      <HeaderBar
        conn={conn}
        title={active?.title}
        sessionId={activeId}
        branch={vcsBranch}
        workspaceName={
          active?.location?.directory
            ? active.location.directory.split(/[\\/]/).filter(Boolean).pop()
            : undefined
        }
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        onRename={async (title) => {
          if (activeId)
            await rpc
              .call("session.rename", { sessionID: activeId, title })
              .catch(() => undefined);
          void refreshSessions();
        }}
        onOpenManager={() => setManagerOpen(true)}
        onOpenProviders={() => setProvidersOpen(true)}
        onOpenMcp={() => setMcpOpen(true)}
        onOpenSavedPermissions={() => setSavedPermsOpen(true)}
        onOpenInstructions={() => {
          if (activeId) setInstructionsOpen(true);
        }}
        onOpenWorktrees={() => setWorktreesOpen(true)}
        onOpenInbox={() => {
          if (activeId) setInboxOpen(true);
        }}
        onExport={() => void exportSession()}
        onImport={() => void importSessionFile()}
        onUndo={() => void undoLastTurn()}
        onRedo={() => void redoRevert()}
        onOpenWorkingDiff={() => void openWorkingDiff()}
        onOpenSettings={() =>
          void rpc.call("settings.open").catch(() => undefined)
        }
        theme={cfg?.ui.theme ?? "dark"}
        themes={THEME_IDS.map((id) => ({
          id,
          label:
            id === "dark"
              ? "OpenCode Dark"
              : id === "light"
                ? "OpenCode Light"
                : id.charAt(0).toUpperCase() + id.slice(1),
        }))}
        onToggleTheme={(id) => {
          if (id) {
            void updateSettings([{ key: "ui.theme", value: id }]);
          } else {
            cycleTheme();
          }
        }}
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
          const forked = await rpc
            .call<SessionSummary>("session.fork", { sessionID: activeId })
            .catch((e: unknown) => {
              console.warn("[oc2] session.fork failed", e);
              setNotice(
                `Couldn't fork session — ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
              return undefined;
            });
          if (forked) {
            await refreshSessions();
            selectSession(forked.id);
          }
        }}
        onCompact={async () => {
          if (!activeId) return;
          await rpc
            .call("session.compact", { sessionID: activeId })
            .catch(() => undefined);
          // Compaction is async server-side; `session.compaction.ended`
          // normally drives the refresh, but some server builds don't emit
          // it — poll a few times so the context bar resets promptly.
          for (const delay of [1_500, 4_000, 8_000]) {
            setTimeout(() => {
              void refreshSessions();
              void refreshMessages(activeId);
            }, delay);
          }
        }}
      />

      {notice && (
        <div className="notice-bar" role="alert">
          <span className="notice-text">{notice}</span>
          <button
            type="button"
            className="chip"
            title="Dismiss"
            onClick={() => setNotice(null)}
          >
            ✕
          </button>
        </div>
      )}

      <main className="feed">
        {conn !== "connected" ? (
          <div className="empty">
            {conn === "connecting" ? (
              <>
                <h2>Connecting…</h2>
                <p>Looking for the OpenCode V2 background service.</p>
                <button
                  type="button"
                  className="chip"
                  style={{ marginTop: "var(--oc2-space-2)" }}
                  onClick={() =>
                    void rpc.call("settings.open").catch(() => undefined)
                  }
                >
                                    Open Settings
                </button>
              </>
            ) : (
              <>
                <h2>Service unreachable</h2>
                {connDetail && <code className="err-detail">{connDetail}</code>}
                <p>
                  Run “OpenCode 2: Restart Background Service” from the command
                  palette.
                </p>
              </>
            )}
          </div>
        ) : !activeId ? (
          <div className="empty">
            <h2>No sessions yet</h2>
            <button
              type="button"
              className="primary"
              onClick={() => void newSession()}
            >
              New session
            </button>
            <div className="empty-hints">
              <span className="micro">
                <kbd>/</kbd> commands &amp; skills
              </span>
              <span className="micro">
                <kbd>@</kbd> attach a file
              </span>
              <span className="micro">
                <kbd>⋯</kbd> themes, inbox &amp; more
              </span>
            </div>
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
            onRetry={() => void retryLast()}
            retryPendingLast={retryPending}
            onAnswer={(text) =>
              void sendMessage(text, undefined, busy ? "steer" : undefined)
            }
            retryNote={
              busy && retryInfo && !retryInfo.action
                ? `↻ retrying${
                    retryInfo.attempt ? ` (attempt ${retryInfo.attempt})` : ""
                  }…`
                : null
            }
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
              await rpc
                .call("session.remove", { sessionID: id })
                .catch(() => undefined);
              if (id === activeId) selectSession(undefined);
              await refreshSessions();
            }}
            onMove={async (id) => {
              const dir = await rpc
                .call<string | undefined>("pick.folder")
                .catch(() => undefined);
              if (!dir) return;
              await rpc
                .call("session.move", { sessionID: id, directory: dir })
                .catch(() => undefined);
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

        {providersOpen && (
          <ProvidersDrawer
            onClose={() => setProvidersOpen(false)}
            refreshTick={providersTick}
          />
        )}

        {mcpOpen && (
          <McpDrawer onClose={() => setMcpOpen(false)} refreshTick={mcpTick} />
        )}

        {savedPermsOpen && (
          <SavedPermissionsDrawer onClose={() => setSavedPermsOpen(false)} />
        )}
        {instructionsOpen && activeId && (
          <InstructionsDrawer
            sessionId={activeId}
            refreshTick={instructionsTick}
            onClose={() => setInstructionsOpen(false)}
          />
        )}
        {worktreesOpen && (
          <WorktreesDrawer
            refreshTick={worktreeTick}
            onClose={() => setWorktreesOpen(false)}
          />
        )}
        {inboxOpen && activeId && (
          <InboxDrawer sessionId={activeId} onClose={() => setInboxOpen(false)} />
        )}
      </main>

      {(() => {
        // ---- consolidated bottom dock ----
        const pending = permissions.filter(
          (p) => p.action.toLowerCase() !== "question",
        );
        const showPermissions =
          permissionMode === "askFirst" && pending.length > 0 && !!activeId;
        return (
          <div className="dock">
            {actionError && (
              <div className="composer-error dock-error">{actionError}</div>
            )}

            {retryInfo?.action && (
              <div
                className="perm-card"
                data-action="retry-action"
                style={{ borderLeftColor: "var(--oc2-question)" }}
              >
                <div className="perm-header">
                  <span
                    className="perm-badge"
                    style={{
                      color: "var(--oc2-question)",
                      borderColor: "var(--oc2-tool-shell-dim)",
                    }}
                  >
                    provider
                  </span>
                  <span>
                    {retryInfo.action.title ?? "Provider action required"}
                  </span>
                </div>
                {retryInfo.action.message && (
                  <div className="perm-res" style={{ whiteSpace: "pre-wrap" }}>
                    {retryInfo.action.message}
                  </div>
                )}
                {retryInfo.action.link && (
                  <div className="perm-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() =>
                        void rpc
                          .call("url.open", { url: retryInfo.action!.link })
                          .catch(() => undefined)
                      }
                    >
                      {retryInfo.action.label ?? "Open"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {forms.map((f) => (
              <FormCard key={f.id} form={f} />
            ))}

            {showPermissions && (
              <div
                className="perm-scroll"
                tabIndex={0}
                aria-label="Permission requests — Enter allow once · A allow always · D or Esc reject"
                onKeyDown={(e) => {
                  const target = e.target as HTMLElement;
                  if (target.closest("button")) return;
                  const first = pending[0];
                  if (!first) return;
                  if (e.key === "a" || e.key === "A") {
                    e.preventDefault();
                    void replyPermission(first.requestID, "always");
                  } else if (e.key === "d" || e.key === "D" || e.key === "Escape") {
                    e.preventDefault();
                    void replyPermission(first.requestID, "reject");
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    void replyPermission(first.requestID, "once");
                  }
                }}
              >
                {pending.map((p) => (
                  <PermissionRow
                    key={p.requestID}
                    perm={p}
                    onReply={(r) => void replyPermission(p.requestID, r)}
                  />
                ))}
              </div>
            )}

            {compacting && (
              <div className="dock-status">
                <span
                  className="retry-pill"
                  title="The server is compacting this session's context"
                >
                  ↻ compacting…
                </span>
              </div>
            )}
          </div>
        );
      })()}

      <Composer
        disabled={!activeId || conn !== "connected"}
        busy={busy}
        sendKey={cfg?.ui.sendKey ?? "enter"}
        catalogTick={slashTick}
        builtins={slashBuiltins}
        onSend={(t, files, delivery) =>
          void sendMessage(t, files, delivery)
        }
        onSendCommand={async (command, args) => {
          if (!activeId) return;
          setBusySessions((b) => ({ ...b, [activeId]: true }));
          try {
            await rpc.call("session.command", {
              sessionID: activeId,
              command,
              args,
            });
          } catch (e) {
            setBusySessions((b) => ({ ...b, [activeId]: false }));
            throw e;
          }
        }}
        onSendSkill={async (name) => {
          if (!activeId) return;
          setBusySessions((b) => ({ ...b, [activeId]: true }));
          try {
            await rpc.call("session.skill", { sessionID: activeId, name });
          } catch (e) {
            setBusySessions((b) => ({ ...b, [activeId]: false }));
            throw e;
          }
        }}
        onStop={() => void interrupt()}
        agents={agents}
        connected={conn === "connected"}
        activeAgent={active?.agent}
        agentName={agents.find((a) => a.id === active?.agent)?.name}
        models={models}
        hidden={cfg?.models.hidden ?? []}
        favorites={cfg?.models.favorites ?? []}
        defaultKey={cfg?.models.default ?? ""}
        recents={recents}
        activeModel={effectiveModel}
        permissionMode={permissionMode}
        onPickPermissionMode={(mode) =>
          void updateSettings([{ key: "permissions.mode", value: mode }])
        }
        onPickModel={async (m) => {
          const key = modelKey(m);
          setRecents((r) => [key, ...r.filter((k) => k !== key)].slice(0, 5));
          setLastUsedModel({ id: m.id, providerID: m.providerID });
          void rpc
            .call("ui.lastModel.set", { id: m.id, providerID: m.providerID })
            .catch(() => undefined);
          if (activeId) {
            setSessions((prev) =>
              prev.map((s) =>
                s.id === activeId
                  ? ({
                      ...s,
                      model: { id: m.id, providerID: m.providerID },
                    } as SessionSummary)
                  : s,
              ),
            );
            await rpc
              .call("model.switch", { sessionID: activeId, model: m })
              .catch(() => undefined);
          }
          void refreshSessions();
        }}
        onPickVariant={async (variant) => {
          const am = effectiveModel;
          if (am) {
            setLastUsedModel({ id: am.id, providerID: am.providerID });
            void rpc
              .call("ui.lastModel.set", { id: am.id, providerID: am.providerID })
              .catch(() => undefined);
          }
          if (activeId && am) {
            const nextModel = variant
              ? { id: am.id, providerID: am.providerID, variant }
              : { id: am.id, providerID: am.providerID };
            setSessions((prev) =>
              prev.map((s) =>
                s.id === activeId
                  ? ({ ...s, model: nextModel } as SessionSummary)
                  : s,
              ),
            );
            await rpc
              .call("model.switch", {
                sessionID: activeId,
                model: { id: am.id, providerID: am.providerID, variant },
              })
              .catch(() => undefined);
          }
          void refreshSessions();
        }}
        onPickAgent={async (a) => {
          if (activeId) {
            await rpc
              .call("agent.switch", { sessionID: activeId, agent: a })
              .catch(() => undefined);
          }
          void refreshSessions();
        }}
        onToggleFavorite={(key) =>
          void updateSettings([
            {
              key: "models.favorites",
              value: toggleInList(cfg?.models.favorites ?? [], key),
            },
          ])
        }
        onOpenManager={() => setManagerOpen(true)}
      />

      <StatusStrip
        connected={conn === "connected"}
        busy={busy}
        cost={active?.cost}
        tokens={active?.tokens}
        ctxPct={ctxPct}
        ctxLimit={ctxLimit}
      />
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
    : perm.action.toLowerCase().includes("edit") ||
        perm.action.toLowerCase().includes("write")
      ? "edit"
      : perm.action.toLowerCase().includes("read")
        ? "read"
        : perm.action.toLowerCase().includes("question")
          ? "question"
          : "other";
  return (
    <div
      className="perm-card"
      data-action={
        perm.action.toLowerCase().includes("shell")
          ? "shell"
          : perm.action.toLowerCase().includes("edit")
            ? "edit"
            : perm.action.toLowerCase().includes("read")
              ? "read"
              : perm.action.toLowerCase().includes("question")
                ? "question"
                : "other"
      }
    >
      <div className="perm-header">
        <span className={`perm-badge ${kind}`}>{perm.action}</span>
        <span>Permission required</span>
      </div>
      {perm.resources.length > 0 ? (
        <div
          className="perm-resources"
          style={{ maxHeight: "160px", overflowY: "auto", paddingRight: "4px" }}
        >
          {perm.resources.map((r, i) => (
            <code key={i} className="perm-res">
              {r}
            </code>
          ))}
        </div>
      ) : (
        <div className="perm-hint">Agent wants to perform this action.</div>
      )}
      <div
        className="perm-actions"
        style={{
          borderTop: "1px solid var(--oc2-border)",
          paddingTop: "8px",
          marginTop: "4px",
        }}
      >
        <button
          type="button"
          className="danger"
          onClick={() => onReply("reject")}
          title="Deny (Esc)"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => onReply("always")}
          title="Always allow — saves pattern for this project"
        >
          Allow always
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => onReply("once")}
          title="Allow this time (Enter)"
        >
          Allow once
        </button>
      </div>
    </div>
  );
}

function mostRecentSession(list: SessionSummary[]): SessionSummary | undefined {
  return [...list].sort((a, b) => b.time.updated - a.time.updated)[0];
}

/** Client-side mirror of the host's toWireForm normalization. */
function toWireFormClient(raw: Record<string, unknown>): WireForm | undefined {
  if (typeof raw.id !== "string" || typeof raw.sessionID !== "string")
    return undefined;
  const fieldsRaw = Array.isArray(raw.fields) ? raw.fields : [];
  return {
    id: raw.id,
    sessionID: raw.sessionID,
    title: typeof raw.title === "string" ? raw.title : "Agent input",
    fields: fieldsRaw
      .filter(
        (f): f is Record<string, unknown> =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as Record<string, unknown>).key === "string",
      )
      .map((f) => ({
        key: f.key as string,
        title: typeof f.title === "string" ? f.title : (f.key as string),
        description:
          typeof f.description === "string" ? f.description : undefined,
        required: f.required === true,
        type: typeof f.type === "string" ? f.type : "string",
        options: Array.isArray(f.options)
          ? (f.options as Array<Record<string, unknown>>).map((o) => ({
              label:
                typeof o.label === "string" ? o.label : String(o.value ?? ""),
              value: o.value as string | number | boolean | undefined,
            }))
          : undefined,
        default:
          typeof f.default === "string" ||
          typeof f.default === "number" ||
          typeof f.default === "boolean"
            ? f.default
            : undefined,
        placeholder:
          typeof f.placeholder === "string" ? f.placeholder : undefined,
      })),
  };
}

/** Render the visible conversation as markdown for clipboard export. */
function buildTranscript(messages: AnyMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (isUser(m)) {
      lines.push(`## 🧑 Prompt\n\n${m.text}\n`);
    } else if (isAssistant(m)) {
      lines.push(
        `## 🤖 ${m.agent}${m.model ? ` (${m.model.providerID}/${m.model.id})` : ""}\n`,
      );
      for (const part of m.content ?? []) {
        if (part.type === "text") lines.push(`${part.text}\n`);
        if (part.type === "reasoning")
          lines.push(`> _thinking:_ ${truncate(part.text, 400)}\n`);
      }
      if (m.cost !== undefined)
        lines.push(
          `_cost: ${formatCost(m.cost)} · ${formatTokens(m.tokens?.input)} in / ${formatTokens(m.tokens?.output)} out_\n`,
        );
    }
  }
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
