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
import {
  modelKey,
  parseModelKey,
  pickNewSessionModel,
  resolveDefault,
  toggleInList,
} from "./lib/models";
import { chime } from "./lib/sound";
import { actionsForEvent, type UiAction } from "./lib/events";
import { applyDelta, type DeltaEvent } from "./lib/deltas";
import {
  autoReplyFor,
  RespondedTracker,
  sameSessionPending,
  lostReplyIds,
} from "./lib/permissions";
import { PROVIDERISH_RE } from "./lib/failure";
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
import { SubagentsDrawer } from "./components/SubagentsDrawer";
import { PlansDrawer } from "./components/PlansDrawer";
import { childrenOf, isSubagentActive } from "./lib/subagents";

type Conn = "connected" | "connecting" | "error";

interface PermissionCardData {
  sessionID: string;
  requestID: string;
  action: string;
  resources: string[];
  /** Proposed file changes shipped by the server for edit permissions. */
  files?: WirePermissionFileDiff[];
}

interface WirePermissionFileDiff {
  file: string;
  patch: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

/** Pull proposed-change metadata out of a permission payload (defensive). */
function extractPermissionFiles(
  metadata: unknown,
): WirePermissionFileDiff[] | undefined {
  const files = (metadata as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return undefined;
  const clean: WirePermissionFileDiff[] = [];
  for (const f of files) {
    if (
      typeof f === "object" &&
      f !== null &&
      typeof (f as { file?: unknown }).file === "string" &&
      typeof (f as { patch?: unknown }).patch === "string"
    ) {
      const rec = f as Record<string, unknown>;
      clean.push({
        file: rec.file as string,
        patch: rec.patch as string,
        additions:
          typeof rec.additions === "number" ? rec.additions : undefined,
        deletions:
          typeof rec.deletions === "number" ? rec.deletions : undefined,
        status: typeof rec.status === "string" ? rec.status : undefined,
      });
    }
  }
  return clean.length > 0 ? clean : undefined;
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
  const busySessionsRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    busySessionsRef.current = busySessions;
  }, [busySessions]);
  /** Providerish auto-recovery: once per session, right after a compaction. */
  const autoRecoveredRef = useRef(new Set<string>());
  const compactionTsRef = useRef<Record<string, number>>({});
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
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const [selectedSubagent, setSelectedSubagent] = useState<
    string | undefined
  >(undefined);
  /** Subagent runs (child sessions) of the active session. */
  const childSubs = useMemo(
    () => childrenOf(sessions, activeId),
    [sessions, activeId],
  );
  const [inboxTick, setInboxTick] = useState(0);
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
  /** Ref mirror of `sounds` — the push listener must not re-subscribe when the
   *  setting toggles (that cleared in-flight debounced refresh timers). */
  const soundsRef = useRef(true);
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

  /** `"providerID/id"` of the active session's bound model (failure tracking). */
  const activeModelKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const m = active?.model as
      | { id?: string; providerID?: string }
      | undefined;
    activeModelKeyRef.current =
      m?.providerID && m?.id ? `${m.providerID}/${m.id}` : undefined;
  }, [active]);

  /** Payload of the most recent failed send (transport/API) — Retry uses this
   *  instead of history, because a failed first prompt leaves no user message. */
  const lastFailedPromptRef = useRef<
    { text: string; files?: Array<{ uri: string; name?: string }> } | undefined
  >(undefined);

  /** Newest assistant-step failure, keyed by its bound model — drives the
   *  smart-retry model repair (P0: fresh sessions bound to broken defaults). */
  const lastFailureRef = useRef<
    { modelKey?: string; message?: string; providerish?: boolean } | undefined
  >(undefined);

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
        // Overlay rules (stream-lag protection):
        //  - text/reasoning: only the LAST local part of each kind may
        //    overlay, and only when it EXTENDS the server snapshot
        //    (startsWith). If the server diverged — revert/compaction shrank
        //    or rewrote it — the authoritative snapshot wins and stale
        //    streams cannot resurrect old content.
        //  - tools match by id (shell output protection below).
        const msgId = (m as { id?: string }).id ?? "";
        const accFor = (kind: string): string | undefined => {
          const acc = deltaAccRef.current.get(`${msgId}|${kind}`);
          return typeof acc === "string" ? acc : undefined;
        };
        let changed = false;
        const lc: Array<Record<string, unknown>> = lm.content;
        const content = mm.content.map((p) => {
          if (
            (p.type === "text" || p.type === "reasoning") &&
            typeof p.text === "string"
          ) {
            let lastIdx = -1;
            for (let i = lc.length - 1; i >= 0; i--) {
              if ((lc[i] as { type?: unknown }).type === p.type) {
                lastIdx = i;
                break;
              }
            }
            if (lastIdx !== -1) {
              const lp = lc[lastIdx] as { text?: unknown };
              const localText = typeof lp.text === "string" ? lp.text : "";
              const acc = accFor(p.type);
              const candidate =
                acc && acc.length > localText.length ? acc : localText;
              if (
                candidate.length > p.text.length &&
                candidate.startsWith(p.text)
              ) {
                changed = true;
                return { ...p, text: candidate };
              }
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
      // Suppress system-reminder lifecycle messages (all agents) that are already
      // conveyed by the whole-UI tint — filter at ingestion so they never reach Feed.
      const REMINDER_RE = /<system-reminder>|You are (?:in|NO LONGER in)\b/i;
      const filtered = merged.filter((m) => {
        const t = (m as { type?: unknown }).type;
        if (t === "assistant") {
          // Strip reminder text/reasoning parts even inside assistant content.
          const c = (m as { content?: Array<{ text?: string }> }).content;
          if (!Array.isArray(c)) return true;
          const kept = c.filter((p) => !(typeof p?.text === "string" && REMINDER_RE.test(p.text)));
          (m as { content?: Array<{ text?: string }> }).content = kept;
          return kept.length > 0;
        }
        try {
          return !REMINDER_RE.test(JSON.stringify(m));
        } catch {
          return true;
        }
      });
      setMessages(filtered);
      // Record the newest assistant-step failure (if any) so smart-retry can
      // repair the model binding and new-session defaults can warn about it.
      const assistants = list.filter(
        (m) => (m as { type?: unknown }).type === "assistant",
      ) as unknown as Array<{
        finish?: string;
        error?: { message?: string; type?: string } | null;
        model?: { id?: string; providerID?: string };
      }>;
      const lastA = assistants[assistants.length - 1];
      if (lastA?.finish === "error" && lastA.error) {
        const msg = String(lastA.error.message ?? lastA.error.type ?? "unknown error");
        const key =
          lastA.model?.providerID && lastA.model?.id
            ? `${lastA.model.providerID}/${lastA.model.id}`
            : undefined;
        lastFailureRef.current = {
          ...(key ? { modelKey: key } : {}),
          message: msg,
          providerish:
            PROVIDERISH_RE.test(msg),
        };
      } else if (lastA && lastA.finish && lastA.finish !== "error") {
        lastFailureRef.current = undefined;
      }
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

  const refreshPendingPermissions = useCallback(
    async (resync = false): Promise<void> => {
      try {
        const pending = (await rpc.call<
          Array<{
            data?: {
              id: string;
              sessionID: string;
              action: string;
              resources?: string[];
              metadata?: unknown;
            };
          }>
        >("permissions.pending")) as unknown as {
          data?: Array<{
            id: string;
            sessionID: string;
            action: string;
            resources?: string[];
            metadata?: unknown;
          }>;
        };
        const rows = pending.data ?? [];
        const ids = new Set(rows.map((r) => r.id));
        if (resync) {
          // On an authoritative re-sync the server's pending list IS ground
          // truth. Any request we previously marked "responded" that the server
          // STILL lists as pending had its reply lost (SSE drop / in-flight
          // race) — forget the stale mark so the auto-reply effect re-sends it
          // instead of wedging the shell command forever.
          for (const id of lostReplyIds(respondedRef.current, ids))
            respondedRef.current.clear(id);
        }
        setPermissions(
          rows.map((r) => ({
            sessionID: r.sessionID,
            requestID: r.id,
            action: r.action,
            resources: r.resources ?? [],
            files: extractPermissionFiles(r.metadata),
          })),
        );
      } catch {
        /* transient */
      }
    },
    [],
  );

  /** Queued follow-ups (session inbox) for the active session — rendered as
   *  ghost bubbles at the feed tail. */
  const [queuedItems, setQueuedItems] = useState<
    Array<{ id: string; text?: string }>
  >([]);
  /** Draft prefill from a message "edit" action (MessageGroup → Composer). */
  const [composerPrefill, setComposerPrefill] = useState<string | undefined>(
    undefined,
  );

  const refreshQueued = useCallback(async () => {
    const sid = activeIdRef.current;
    if (!sid) {
      setQueuedItems([]);
      return;
    }
    try {
      const rows = await rpc.call<Array<Record<string, unknown>>>(
        "inbox.list",
        { sessionID: sid },
      );
      setQueuedItems(
        (rows ?? []).map((r) => {
          const payload = (r.payload ?? {}) as Record<string, unknown>;
          return {
            id: typeof r.id === "string" ? r.id : "",
            text: typeof payload.text === "string" ? payload.text : undefined,
          };
        }),
      );
    } catch {
      /* transient — keep previous state */
    }
  }, []);

  const selectSession = useCallback(
    (id: string | undefined) => {
      setActiveId(id);
      setMessages([]);
      setPermissions([]);
      // Streamed accumulators belong to the abandoned view — drop them so
      // stale streams can never overlay the next session's transcript.
      deltaAccRef.current.clear();
      setForms((list) => (id ? list.filter((f) => f.sessionID === id) : []));
      setQueuedItems([]); // refetched for the new session below
      if (id) {
        void refreshMessages(id);
        void refreshQueued();
      }
    },
    [refreshMessages, refreshQueued],
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

  useEffect(() => {
    soundsRef.current = sounds;
  }, [sounds]);

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
    // Accumulator for the debounced event router — events within one debounce
    // window must MERGE their refresh actions, not replace each other's.
    const pendingActions = new Set<UiAction>();
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
              void refreshPendingPermissions(true);
              void refreshForms();
              void refreshQueued();
              setActiveId((current) => {
                if (!current) {
                  // Restore the last-open session when it still exists; else
                  // fall back to the most recent one.
                  const restore =
                    msg.lastSession &&
                    list.some((s) => s.id === msg.lastSession)
                      ? msg.lastSession
                      : undefined;
                  const target = restore
                    ? restore
                    : (mostRecentSession(list)?.id ?? undefined);
                  if (target) void refreshMessages(target);
                  return target;
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
            void refreshPendingPermissions(true);
            void refreshForms();
            void refreshQueued();
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
          if (soundsRef.current && sid && sid !== activeIdRef.current) {
            if (evt.type === "session.execution.succeeded") chime("done");
            if (evt.type === "permission.asked") chime("attention");
          }

          const isTerminal =
            evt.type === "session.execution.succeeded" ||
            evt.type === "session.execution.failed" ||
            evt.type === "session.execution.interrupted";
          if (
            (isTerminal || evt.type === "session.idle") &&
            soundsRef.current &&
            sid === activeIdRef.current
          ) {
            if (isTerminal) chime("done");
          }

          // ---- typed event router (Q18: every valuable V2 event wired) ----
          const actions = actionsForEvent(evt.type);
          if (actions.length > 0) {
            // MERGE into the pending set — replacing it dropped refreshes when
            // two action-bearing events landed within the debounce window.
            for (const a of actions) pendingActions.add(a);
            clearTimeout(sessionTimer);
            sessionTimer = setTimeout(() => {
              const batch = [...pendingActions];
              pendingActions.clear();
              for (const a of batch) {
                if (a === "sessions") void refreshSessions();
                if (a === "pickers") void refreshPickers();
                if (a === "permissions") void refreshPendingPermissions();
                if (a === "forms") void refreshForms();
                if (a === "mcp") setMcpTick((t) => t + 1);
                if (a === "providers") setProvidersTick((t) => t + 1);
                if (a === "vcs") void refreshVcs();
                if (a === "worktrees") setWorktreeTick((t) => t + 1);
                if (a === "instructions") setInstructionsTick((t) => t + 1);
                if (a === "inbox") {
                  setInboxTick((t) => t + 1);
                  void refreshQueued();
                }
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
            } else if (
              wantsMessages ||
              isTerminal ||
              isDelta ||
              evt.type === "session.tool.progress" ||
              evt.type === "session.tool.input.delta"
            ) {
              // Unapplied tool deltas/progress mean the snapshot lags (or the
              // target tool isn't cached) — refetch instead of dropping.
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
              if (evt.type === "session.execution.failed") {
                setRetryPending(true);
                // P0: failures were previously invisible (message "vanished").
                // Surface the server-side reason immediately.
                const err = (
                  evt.data as
                    | { error?: { message?: string; type?: string } }
                    | undefined
                )?.error;
                const msg = err?.message || err?.type || "execution failed";
                lastFailureRef.current = {
                  ...(activeModelKeyRef.current
                    ? { modelKey: activeModelKeyRef.current }
                    : {}),
                  message: msg,
                  providerish: PROVIDERISH_RE.test(
                    msg,
                  ),
                };
                setNotice(`Run failed — ${msg}`);
                const isProvR = PROVIDERISH_RE.test(msg);
                if (isProvR && sid && !autoRecoveredRef.current.has(sid)) {
                  autoRecoveredRef.current.add(sid);
                  const recentC = compactionTsRef.current[sid];
                  if (recentC && Date.now() - recentC < 30_000) {
                    window.setTimeout(() => {
                      if (activeIdRef.current === sid) void retryLast();
                    }, 800);
                  }
                }
              } else {
                setRetryPending(false);
              }
            }
            // Compaction progress pill.
            if (evt.type === "session.compaction.started")
              setCompacting(true);
            if (
              evt.type === "session.compaction.ended" ||
              evt.type === "session.compaction.failed"
            ) {
              setCompacting(false);
              if (sid) compactionTsRef.current[sid] = Date.now();
            }
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
                  : [
                      ...list,
                      {
                        sessionID: data.sessionID,
                        requestID,
                        action: data.action ?? "",
                        resources: data.resources ?? [],
                        files: extractPermissionFiles(
                          (data as { metadata?: unknown }).metadata,
                        ),
                      },
                    ],
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
     refreshQueued,
     selectSession,
   ]);

  const restartService = useCallback(async () => {
    try {
      await rpc.call("service.restart");
      setNotice(null);
    } catch (e) {
      setNotice(
        `Restart failed — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, []);

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

  const newSession = useCallback(async (): Promise<string | undefined> => {
    try {
      // Defaults: last-used model wins; then the configured default (built-in:
      // OpenCode Zen's free big-pickle); then the server default. Every
      // candidate is validated against the catalog with a free-Zen safety net.
      const def = pickNewSessionModel(
        lastUsedModel,
        cfg?.models.default ?? "",
        serverDefault,
        models,
      );
      if (def) {
        const key = `${def.providerID}/${def.id}`;
        const failure = lastFailureRef.current;
        if (failure?.modelKey === key && failure.message) {
          setNotice(
            `Heads up: ${key} failed recently (${failure.message}). Consider picking a different model.`,
          );
        }
      }
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
      return session.id;
    } catch (error) {
      console.warn("[oc2] session.create failed", error);
      setNotice(
        `Couldn't create session — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }, [cfg, serverDefault, lastUsedModel, models, refreshSessions, selectSession]);

  const ensureSessionForSend = useCallback(async (): Promise<string | undefined> => {
    if (activeIdRef.current) return activeIdRef.current;
    // Only auto-create when the project genuinely has no sessions (not just no selection).
    if (sessions.length > 0) {
      const recent = sessions[0]?.id;
      if (recent) {
        selectSession(recent);
        return recent;
      }
      return undefined;
    }
    return newSession();
  }, [sessions, newSession, selectSession]);

  // ---- actions -------------------------------------------------------------
  const sendMessage = useCallback(
    async (
      text: string,
      files?: Array<{ uri: string; name?: string }>,
      delivery?: "steer" | "queue",
    ) => {
      // Lazy creation: if no session is active but the project has none, create one on first send.
      let targetId = activeIdRef.current;
      if (!targetId) {
        if (sessions.length === 0) {
          const created = await newSession();
          if (!created) return;
          targetId = created;
        } else {
          return;
        }
      }
      if (!text.trim() && (!files || files.length === 0)) return;
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
      setBusySessions((b) => ({ ...b, [targetId!]: true }));
      setRetryInfo(undefined); // a fresh run must not inherit stale retry state
      try {
        const params: Record<string, unknown> = {
          sessionID: targetId,
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
        // The optimistic bubble must not hang if the first refetch raced the
        // server's persistence of the user message — re-sync shortly after.
        window.setTimeout(() => void refreshMessages(targetId!), 400);
        // Queued sends land in the inbox, not the transcript — show them.
        if (delivery === "queue") void refreshQueued();
      } catch (error) {
        setMessages((m) => m.filter((x) => x.id !== optimistic.id));
        setBusySessions((b) => ({ ...b, [targetId!]: false }));
        // Surface a Retry affordance for transport/API failures — and keep the
        // exact payload so Retry resends THIS prompt, not an older one.
        lastFailedPromptRef.current = { text: text || "", files };
        setRetryPending(true);
        throw error;
      }
    },
    [activeId, sessions.length, newSession, refreshMessages, refreshQueued],
  );

  /** Resend the failed prompt — prefers the exact retained payload from the
   *  last failed send, falling back to history for older failures.
   *
   *  Smart repair (P0): when the newest failure was a provider/model error on
   *  this session's bound model, first switch to a validated working model
   *  (configured default → free Zen) so a broken default can't wedge the
   *  session permanently. */
  const retryLast = useCallback(async () => {
    if (!activeId) return;
    const failure = lastFailureRef.current;
    if (
      failure?.providerish &&
      failure.modelKey &&
      failure.modelKey === activeModelKeyRef.current
    ) {
      const candidate = pickNewSessionModel(
        undefined,
        cfg?.models.default ?? "",
        serverDefault,
        models,
      );
      const candidateKey = candidate
        ? `${candidate.providerID}/${candidate.id}`
        : undefined;
      if (candidate && candidateKey && candidateKey !== failure.modelKey) {
        try {
          await rpc.call("model.switch", {
            sessionID: activeId,
            model: candidate,
          });
          activeModelKeyRef.current = candidateKey;
          setSessions((prev) =>
            prev.map((s) =>
              s.id === activeId
                ? ({ ...s, model: { ...candidate } } as SessionSummary)
                : s,
            ),
          );
          setNotice(
            `Model ${failure.modelKey} keeps failing (${
              failure.message ?? "provider error"
            }) — switched to ${candidateKey}; retrying.`,
          );
        } catch {
          /* switching failed — retry with the current model regardless */
        }
      }
    }
    const retained = lastFailedPromptRef.current;
    if (retained) {
      lastFailedPromptRef.current = undefined;
      try {
        await sendMessage(
          retained.text,
          retained.files && retained.files.length > 0 ? retained.files : undefined,
        );
      } catch {
        /* failure state already surfaced */
      }
      return;
    }
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
  }, [activeId, sendMessage, cfg, serverDefault, models]);

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
      reply: "once" | "always" | "reject" | "session",
    ): Promise<boolean> => {
      const target = permissions.find((p) => p.requestID === requestID);
      const finalReply: "once" | "always" | "reject" = reply === "session" ? "once" : reply;
      if (reply === "session" && target) autoAcceptSessionsRef.current.add(target.sessionID);
      if (!target) return false;

      // OpenCode cancels every pending permission request in the session when
      // one is rejected; reject them together so the user isn't left dismissing
      // each one by hand.
      const toReject =
        finalReply === "reject"
          ? [requestID, ...sameSessionPending(permissions, target.sessionID, requestID)]
          : [requestID];

      setPermissions((list) => list.filter((p) => !toReject.includes(p.requestID)));
      try {
        await Promise.all(
          toReject.map((id) =>
            rpc.call("permission.reply", {
              sessionID: target.sessionID,
              requestID: id,
              reply: finalReply,
            }),
          ),
        );
        return true;
      } catch {
        // Restore the card immediately (the agent is still blocked on it) and
        // schedule a fresh sync in case our copy is stale.
        setPermissions((list) =>
          list.some((p) => p.requestID === requestID) ? list : [...list, target],
        );
        respondedRef.current.clear(requestID);
        void refreshPendingPermissions();
        return false;
      }
    },
    [permissions, refreshPendingPermissions],
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
        onOpenPlan={() => setPlansOpen(true)}
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
        onRevertClear={async () => {
          if (!activeId) return;
          await rpc
            .call("session.revert.clear", { sessionID: activeId, files: true })
            .catch((e: unknown) => {
              console.warn("[oc2] revert.clear failed", e);
              setNotice(
                `Couldn't abandon staged changes — ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            });
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
        {conn !== "connected" && activeId && (
          /* Non-blocking reconnect banner (M5): keep the cached transcript
             visible instead of wiping the feed on transient drops. */
          <div className="notice-bar" role="alert">
            <span className="notice-text">
              {conn === "connecting"
                ? "Connection lost — reconnecting…"
                : `Service unreachable${connDetail ? `: ${connDetail}` : ""}`}
            </span>
            <button
              type="button"
              className="chip"
              onClick={() => void restartService()}
            >
              ↻ Restart Background Service
            </button>
          </div>
        )}
        {conn !== "connected" && !activeId ? (
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
                <button
                  type="button"
                  className="primary"
                  style={{ marginTop: "var(--oc2-space-2)" }}
                  onClick={() =>
                    void rpc
                      .call("cli.start")
                      .then(() => setNotice(null))
                      .catch((e: unknown) =>
                        setNotice(
                          `Couldn't start opencode2 — ${e instanceof Error ? e.message : String(e)}`,
                        ),
                      )
                  }
                >
                  Start opencode2
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => void restartService()}
                >
                  ↻ Restart Background Service
                </button>
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
            retryInfo={retryInfo}
            compacting={compacting}
            queued={queuedItems}
            onQueuedOpen={() => setInboxOpen(true)}
            onUnqueue={(id) =>
              void rpc
                .call("inbox.cancel", { sessionID: activeId, inboxID: id })
                .then(() => refreshQueued())
                .catch((e: unknown) =>
                  setNotice(
                    `Couldn't remove queued message — ${
                      e instanceof Error ? e.message : String(e)
                    }`,
                  ),
                )
            }
            onCopyMessage={(m) => {
              const t = (m as { text?: unknown }).text;
              const parts = (m as { content?: Array<{ text?: string }> }).content;
              const md =
                typeof t === "string"
                  ? t
                  : Array.isArray(parts)
                    ? parts.filter((p) => p?.text).map((p) => p.text).join("\n")
                    : "";
              void rpc
                .call("transcript.copy", { markdown: md })
                .catch(() => undefined);
            }}
            onRegenerate={() => void retryLast()}
            onEditMessage={(text) => setComposerPrefill(text)}
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
              let removed = true;
              await rpc
                .call("session.remove", { sessionID: id })
                .catch(() => {
                  removed = false;
                  setNotice(`Couldn't delete session ${id}`);
                });
              // Only deselect when the removal actually succeeded — otherwise
              // the feed flips to the empty state while the session still exists.
              if (removed && id === activeId) selectSession(undefined);
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
          <InboxDrawer
            sessionId={activeId}
            refreshTick={inboxTick}
            onClose={() => setInboxOpen(false)}
          />
        )}
      </main>

      {(() => {
        // ---- consolidated bottom dock ----
        const pending = permissions.filter(
          (p) => p.action.toLowerCase() !== "question",
        );
        // Auto-acknowledged permissions (autoAllow mode, or a session the user
        // put in auto-accept) never need a decision — render them as plain,
        // non-blocking text and let the auto-reply effect answer them. Only
        // genuinely interactive (askFirst, not auto-accepted) perms keep the
        // Allow/Deny card so the user can still Deny.
        const isAutoPerm = (p: PermissionCardData): boolean =>
          autoReplyFor(
            permissionMode,
            p.action,
            autoAcceptSessionsRef.current.has(p.sessionID),
          ) !== undefined;
        const autoPerms = pending.filter(isAutoPerm);
        const interactivePerms = pending.filter((p) => !isAutoPerm(p));
        const showPermissions = interactivePerms.length > 0;
        return (
          <div className="dock">
            {actionError && (
              <div className="composer-error dock-error">{actionError}</div>
            )}

            
            {forms.map((f) => (
              <FormCard key={f.id} form={f} />
            ))}

            {showPermissions && interactivePerms.some((p) => p.files?.length) && (
              /* Review-Diffs summary strip (Module 1): every proposed file
                 change across pending interactive edit permissions with ± counts. */
              <div className="dock-status" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <span
                  className="micro"
                  style={{ opacity: 0.75 }}
                  title="Proposed changes waiting for approval — nothing is written to disk yet"
                >
                  ⇔ Proposed changes
                </span>
                {interactivePerms
                  .flatMap((p) => (p.files ?? []).map((f) => ({ perm: p, f })))
                  .map(({ perm, f }, i) => (
                    <div
                      key={`${perm.requestID}:${i}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {f.status === "added" ? "+" : f.status === "deleted" ? "−" : ""}
                        {f.file}
                      </code>
                      <span className="micro">
                        {typeof f.additions === "number" ? `+${f.additions}` : ""}{" "}
                        {typeof f.deletions === "number" ? `−${f.deletions}` : ""}
                      </span>
                      <button
                        type="button"
                        className="chip"
                        title="Open side-by-side diff of the proposed changes"
                        onClick={() =>
                          void rpc
                            .call("diff.previewPreApply", {
                              file: f.file,
                              patch: f.patch,
                              additions: f.additions,
                              deletions: f.deletions,
                              status: f.status,
                            })
                            .catch(() => undefined)
                        }
                      >
                        ⇔ Review
                      </button>
                    </div>
                  ))}
              </div>
            )}

            {autoPerms.length > 0 && (
              /* Auto-acknowledged permissions: plain, non-blocking text — the
                 auto-reply effect answers them, so no card/buttons are shown. */
              <div className="perm-text-strip" aria-live="polite">
                {autoPerms.map((p) => {
                  const kind = p.action.toLowerCase().includes("shell")
                    ? "shell"
                    : p.action.toLowerCase().includes("edit") ||
                        p.action.toLowerCase().includes("write")
                      ? "edit"
                      : p.action.toLowerCase().includes("read")
                        ? "read"
                        : "other";
                  return (
                    <span
                      key={p.requestID}
                      className="perm-text"
                      data-action={kind}
                      title="Auto-allowed — no action needed"
                    >
                      OpenCode 2 → {p.action} · auto-allowed
                    </span>
                  );
                })}
              </div>
            )}

            {showPermissions && (
              <div
                className="perm-scroll"
                tabIndex={0}
                aria-label="Permission requests — Enter allow once · A allow always · D or Esc reject"
                onKeyDown={(e) => {
                  const target = e.target as HTMLElement;
                  if (target.closest("button")) return;
                  const first = interactivePerms[0];
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
                {interactivePerms.map((p) => (
                  <PermissionRow
                    key={p.requestID}
                    perm={p}
                    onReply={(r) => void replyPermission(p.requestID, r)}
                    onPreviewFile={(f) =>
                      void rpc
                        .call("diff.previewPreApply", {
                          file: f.file,
                          patch: f.patch,
                          additions: f.additions,
                          deletions: f.deletions,
                          status: f.status,
                        })
                        .catch((e: unknown) =>
                          setNotice(
                            `Couldn't open diff — ${
                              e instanceof Error ? e.message : String(e)
                            }`,
                          ),
                        )
                    }
                  />
                ))}
              </div>
            )}

          </div>
        );
      })()}

      {childSubs.length > 0 && (
        /* Subagent status chips (Module 6): clickable per child session. */
        <div className="strip" style={{ padding: "2px 8px" }}>
          {childSubs.slice(0, 5).map((s) => (
            <button
              key={s.id}
              type="button"
              className={`chip${isSubagentActive(s) ? " on" : ""}`}
              title={`${s.title || s.agent || "subagent"} — ${isSubagentActive(s) ? "running" : "finished"} · click to inspect`}
              onClick={() => {
                setSelectedSubagent(s.id);
                setSubagentsOpen(true);
              }}
            >
              🤖 {s.agent ?? "subagent"}
              {isSubagentActive(s) ? " ●" : ""}
            </button>
          ))}
          <span className="spacer" />
          <button
            type="button"
            className="chip"
            title="Open the subagent inspector"
            onClick={() => setSubagentsOpen(true)}
          >
            inspector
          </button>
        </div>
      )}

      <Composer
        disabled={((!activeId && sessions.length > 0) || conn !== "connected")}
        busy={busy}        sendKey={cfg?.ui.sendKey ?? "enter"}
        catalogTick={slashTick}
        builtins={slashBuiltins}
        onSend={(t, files, delivery) => {
          // Surface transport/API send failures instead of swallowing them.
          void sendMessage(t, files, delivery).catch((e: unknown) =>
            setNotice(
              `Send failed — ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }}
        prefill={composerPrefill}
        onPrefillConsumed={() => setComposerPrefill(undefined)}
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
            const prevModel = active?.model;
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
            try {
              await rpc.call("model.switch", { sessionID: activeId, model: m });
            } catch {
              // Roll back the optimistic selector update on failure.
              if (prevModel)
                setSessions((prev) =>
                  prev.map((s) =>
                    s.id === activeId
                      ? ({ ...s, model: prevModel } as SessionSummary)
                      : s,
                  ),
                );
            }
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

      {plansOpen && (
        <PlansDrawer
          canRun={!!activeId && conn === "connected"}
          onClose={() => setPlansOpen(false)}
          onRunPrompt={(text) => {
            // Route through the normal composer send path (steer while busy).
            void sendMessage(text, undefined, busy ? "steer" : undefined).catch(
              (e: unknown) =>
                setNotice(
                  `Send failed — ${e instanceof Error ? e.message : String(e)}`,
                ),
            );
          }}
        />
      )}

      {subagentsOpen && (
        <SubagentsDrawer
          subagents={childSubs}
          initialId={selectedSubagent}
          onClose={() => setSubagentsOpen(false)}
        />
      )}

      <StatusStrip
        connected={conn === "connected"}
        busy={busy}
        cost={active?.cost}
        tokens={active?.tokens}
        ctxPct={ctxPct}
        ctxLimit={ctxLimit}
        model={
          effectiveModel
            ? `${effectiveModel.providerID}/${effectiveModel.id}`
            : undefined
        }
        alertPct={
          cfg?.agent.autoCompactThreshold && cfg.agent.autoCompactThreshold > 0
            ? cfg.agent.autoCompactThreshold
            : 85
        }
      />
    </div>
  );
}

function PermissionRow({
  perm,
  onReply,
  onPreviewFile,
}: {
  perm: PermissionCardData;
  onReply: (reply: "once" | "always" | "reject" | "session") => void;
  onPreviewFile: (f: WirePermissionFileDiff) => void;
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
      {perm.files && perm.files.length > 0 ? (
        /* Proposed changes (server-provided FileDiff metadata): file list with
           ±counts and a native side-by-side preview per file — nothing has
           been written to disk yet. */
        <div
          className="perm-resources"
          style={{ maxHeight: "220px", overflowY: "auto", paddingRight: "4px" }}
        >
          {perm.resources.length > 0 &&
            !perm.files.some((f) => perm.resources.includes(f.file)) && (
              <>
                {perm.resources.map((r, i) => (
                  <code key={`r${i}`} className="perm-res">
                    {r}
                  </code>
                ))}
              </>
            )}
          {perm.files.map((f, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                width: "100%",
              }}
            >
              <code className="perm-res" style={{ flex: 1, minWidth: 0 }}>
                {f.status === "added" ? "+" : f.status === "deleted" ? "−" : ""}
                {f.file}
              </code>
              <span
                className="micro"
                title={`${f.additions ?? 0} additions, ${f.deletions ?? 0} deletions`}
              >
                {typeof f.additions === "number" ? `+${f.additions}` : ""}{" "}
                {typeof f.deletions === "number" ? `−${f.deletions}` : ""}
              </span>
              <button
                type="button"
                className="chip"
                title="Open side-by-side diff of the proposed changes (nothing is written yet)"
                onClick={() => onPreviewFile(f)}
              >
                ⇔ Review
              </button>
            </div>
          ))}
        </div>
      ) : perm.resources.length > 0 ? (
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
          onClick={() => onReply("session")}
          title="Allow for this session — future requests in this session auto-allow (like Ctrl+A in the CLI)"
        >
          ⊞ Allow for session
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
