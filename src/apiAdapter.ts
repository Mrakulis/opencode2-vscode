import type {
  AgentInfo,
  ModelInfo,
  OpenCodeClient,
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode-ai/client";
import path from "node:path";
import type { SessionStats, SessionStatsTokenTotals } from "./protocol";

/**
 * The ONLY module that calls the OpenCode V2 client.
 *
 * `@opencode-ai/client@beta` may churn before stable; every call site in this
 * extension goes through these functions so upstream changes localize here.
 * Keep it free of `vscode` imports so it stays unit-testable under plain node.
 */

export interface ApiAdapterDeps {
  getClient(): OpenCodeClient;
}

/**
 * Beta drift: several list endpoints return a BARE array while others wrap
 * `{ data }`. Normalize both so a server-side shape change degrades to an
 * empty list instead of a TypeError that blanks whole pickers.
 */
function asRows<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const data = (res as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

/** Row shape of model.list entries we rely on (SDK types drift around it). */
type ModelRow = Omit<ModelInfo, "enabled" | "limit"> & {
  enabled?: boolean;
  limit?: { context?: number };
};

/** Finite-number coercion: stats must never surface NaN in the UI. */
function finiteNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function statTokens(v: unknown): SessionStatsTokenTotals {
  const t = (v ?? {}) as Record<string, unknown>;
  const cache = (t.cache ?? {}) as Record<string, unknown>;
  return {
    input: finiteNum(t.input),
    output: finiteNum(t.output),
    reasoning: finiteNum(t.reasoning),
    cacheRead: finiteNum(cache.read),
    cacheWrite: finiteNum(cache.write),
  };
}

function statTools(v: unknown): SessionStats["tools"] {
  const t = (v ?? {}) as Record<string, unknown>;
  if (t.mode !== "summary" && t.mode !== "detail") return { mode: "none" };
  const tot = (t.totals ?? {}) as Record<string, unknown>;
  const totals = {
    calls: finiteNum(tot.calls),
    succeeded: finiteNum(tot.succeeded),
    failed: finiteNum(tot.failed),
    unfinished: finiteNum(tot.unfinished),
  };
  if (t.mode === "summary") return { mode: "summary", totals };
  const usage = Array.isArray(t.usage)
    ? (t.usage as Array<Record<string, unknown>>).map((u) => ({
        name: String(u.name ?? "?"),
        calls: finiteNum(u.calls),
        succeeded: finiteNum(u.succeeded),
        failed: finiteNum(u.failed),
        unfinished: finiteNum(u.unfinished),
      }))
    : [];
  return { mode: "detail", totals, usage };
}

export function createApi({ getClient }: ApiAdapterDeps) {
  return {
    health: () => getClient().health.get(),

    // -- sessions ------------------------------------------------------------
    sessionList: async (directory?: string): Promise<SessionInfo[]> => {
      // Server's `?directory=` filter is case-sensitive (drive letter `E:` vs
      // `e:` on Windows). Fetch all and filter case-insensitively here so
      // `e:\_Code\...` matches stored `E:\_Code\...`.
      const res = await getClient().session.list();
      const root = directory
        ? path.normalize(directory).toLowerCase()
        : undefined;
      let data = res.data;
      if (root) {
        const sep = path.sep.toLowerCase();
        data = data.filter((s) => {
          const dir = s.location?.directory
            ? path.normalize(s.location.directory).toLowerCase()
            : undefined;
          return (
            dir !== undefined && (dir === root || dir.startsWith(root + sep))
          );
        });
      }
      return data;
    },
    sessionCreate: (input: {
      title?: string;
      agent?: string;
      directory?: string;
      model?: { id: string; providerID: string };
    }): Promise<SessionInfo> => {
      const { directory, model, ...rest } = input;
      return getClient().session.create({
        ...rest,
        ...(model ? { model } : {}),
        location: directory ? { directory } : undefined,
      });
    },
    sessionGet: (sessionID: string): Promise<SessionInfo> =>
      getClient().session.get({ sessionID }),
    sessionRemove: (sessionID: string): Promise<void> =>
      getClient().session.remove({ sessionID }),
    sessionRename: (sessionID: string, title: string): Promise<void> =>
      getClient().session.rename({ sessionID, title }),

    // -- conversation --------------------------------------------------------
    messages: async (sessionID: string): Promise<SessionMessageInfo[]> => {
      const res = await getClient().message.list({ sessionID });
      return asRows<SessionMessageInfo>(res);
    },
    prompt: (input: {
      sessionID: string;
      text: string;
      files?: Array<{
        uri: string;
        name?: string;
        mention?: { start: number; end: number; text: string };
      }>;
      delivery?: "steer" | "queue";
    }): Promise<unknown> =>
      getClient().session.prompt({
        sessionID: input.sessionID,
        text: input.text,
        files: input.files,
        delivery: input.delivery,
      }),
    interrupt: (sessionID: string): Promise<unknown> =>
      getClient().session.interrupt({ sessionID }),
    compact: (sessionID: string): Promise<unknown> =>
      getClient().session.compact({ sessionID }),
    fork: (sessionID: string): Promise<SessionInfo> =>
      getClient().session.fork({ sessionID, boundary: { type: "through" } }),

    // -- session parity (export / move / revert / context / inbox) -------------
    exportSession: async (sessionID: string): Promise<unknown> => {
      const res = await getClient().session.export({ sessionID });
      return res;
    },
    importSession: (payload: unknown): Promise<SessionInfo> =>
      getClient().session.import(payload as never),
    moveSession: (sessionID: string, directory: string): Promise<void> =>
      getClient().session.move({ sessionID, directory }),
    revertStage: (
      sessionID: string,
      messageID: string,
      files?: boolean,
    ): Promise<unknown> =>
      getClient().session.revert.stage({
        sessionID,
        messageID,
        ...(files !== undefined ? { files } : {}),
      }),
    revertClear: (sessionID: string): Promise<void> =>
      getClient().session.revert.clear({ sessionID }),
    revertCommit: (sessionID: string): Promise<void> =>
      getClient().session.revert.commit({ sessionID }),
    sessionContext: async (
      sessionID: string,
    ): Promise<Array<Record<string, unknown>>> => {
      const rows = await getClient().session.context({ sessionID });
      return (
        Array.isArray(rows)
          ? rows
          : ((rows as unknown as { data?: unknown[] }).data ?? [])
      ) as Array<Record<string, unknown>>;
    },
    inboxList: async (
      sessionID: string,
    ): Promise<Array<Record<string, unknown>>> => {
      const res = (await getClient().session.inbox.list({
        sessionID,
      })) as unknown;
      return Array.isArray(res)
        ? (res as Array<Record<string, unknown>>)
        : (((res as { data?: unknown[] }).data ?? []) as Array<
            Record<string, unknown>
          >);
    },
    inboxCancel: (sessionID: string, inboxID: string): Promise<void> =>
      getClient().session.inbox.cancel({ sessionID, inboxID }),
    inboxSteer: (sessionID: string, inboxID: string): Promise<void> =>
      getClient().session.inbox.steer({ sessionID, inboxID }),
    inboxQueue: (sessionID: string, inboxID: string): Promise<void> =>
      getClient().session.inbox.queue({ sessionID, inboxID }),

    // -- ambient state (active sessions / unread / auto-title) ------------------
    /** IDs of sessions currently running in the foreground of ANY client. */
    sessionActive: async (): Promise<string[]> => {
      const res = (await getClient().session.active()) as unknown;
      // This beta returns a bare object map `{ [sessionID]: { type: "running" } }`.
      // Guard both shapes — an array wrapper or wrapped `{ data }` object.
      if (Array.isArray(res)) {
        return (res as Array<{ id?: unknown }>)
          .map((r) => (typeof r.id === "string" ? r.id : ""))
          .filter(Boolean);
      }
      const rec = (res ?? {}) as Record<string, unknown>;
      const inner = (rec.data ?? rec) as Record<string, unknown>;
      return Object.entries(inner)
        .filter(
          ([, v]) =>
            v === "running" ||
            (typeof v === "object" &&
              v !== null &&
              (v as { type?: unknown }).type === "running"),
        )
        .map(([k]) => k);
    },
    /** Mark a session's idle transition as viewed (clears its unread dot). */
    sessionView: (sessionID: string, idle: number): Promise<void> =>
      getClient().session.view({ sessionID, idle }),
    /** Transient title text generated from session context (no history mutation). */
    sessionGenerate: async (
      sessionID: string,
      prompt: string,
    ): Promise<string | undefined> => {
      const res = (await getClient().session.generate({
        sessionID,
        prompt,
      })) as unknown;
      const d = (res ?? {}) as { data?: unknown };
      const text = (
        d.data && typeof d.data === "object"
          ? (d.data as Record<string, unknown>).text
          : typeof res === "object" && res !== null
            ? (d as { text?: unknown }).text
            : undefined
      ) as unknown;
      return typeof text === "string" && text.length > 0 ? text : undefined;
    },

    // -- usage stats -----------------------------------------------------------
    /**
     * Aggregated usage across ALL projects (server-side session.stats).
     * Verified live 2026-08-27: the bare call returns tools.mode "summary";
     * the SDK's nested tools-detail input is currently ignored by the server,
     * so detail rows render only if the server default ever changes.
     */
    sessionStats: async (): Promise<SessionStats> => {
      const res = (await getClient().session.stats()) as unknown;
      const d = (res ?? {}) as Record<string, unknown>;
      const s = (d.data ?? d) as Record<string, unknown>;
      return {
        sessions: finiteNum(s.sessions),
        subagents: finiteNum(s.subagents),
        prompts: finiteNum(s.prompts),
        steps: finiteNum(s.steps),
        cost: finiteNum(s.cost),
        activeDays: finiteNum(s.activeDays),
        streak: finiteNum(s.streak),
        tokens: statTokens(s.tokens),
        tools: statTools(s.tools),
        activity: Array.isArray(s.activity)
          ? (s.activity as Array<Record<string, unknown>>)
              .map((a) => ({
                date: String(a.date ?? ""),
                steps: finiteNum(a.steps),
              }))
              .filter((a) => a.date !== "")
          : [],
        models: Array.isArray(s.models)
          ? (s.models as Array<Record<string, unknown>>).map((m) => {
              // Verified live 2026-08-27: `model` arrives as a flat
              // "provider/id" string — normalize object refs too, just in case.
              const ref = m.model;
              const model =
                typeof ref === "string"
                  ? ref
                  : `${String((ref as Record<string, unknown>).providerID ?? "?")}/${String((ref as Record<string, unknown>).id ?? "?")}`;
              return {
                model,
                steps: finiteNum(m.steps),
                cost: finiteNum(m.cost),
                tokens: statTokens(m.tokens),
              };
            })
          : [],
      };
    },

    // -- pickers -------------------------------------------------------------
    models: async (): Promise<Array<ModelInfo & { context: number }>> => {
      const rows = asRows<ModelRow>(await getClient().model.list());
      return rows
        .filter((m) => m.enabled !== false)
        .map((m) => ({
          ...m,
          // normalize: downstream expects top-level `context` = limit.context
          // and `id` consistent with ModelRef (modelID is canonical)
          id: (m as unknown as { modelID?: string }).modelID ?? m.id,
          context: m.limit?.context ?? 0,
        })) as Array<ModelInfo & { context: number }>;
    },
    agents: async (): Promise<AgentInfo[]> => {
      const rows = asRows<AgentInfo>(await getClient().agent.list());
      return rows.filter((a) => !a.hidden && a.mode !== "subagent");
    },
    switchModel: (
      sessionID: string,
      model: { id: string; providerID: string; variant?: string },
    ): Promise<void> => getClient().session.switchModel({ sessionID, model }),
    switchAgent: (sessionID: string, agent: string): Promise<void> =>
      getClient().session.switchAgent({ sessionID, agent }),

    // -- permissions ---------------------------------------------------------
    pendingPermissions: () => getClient().permission.request.list(),
    replyPermission: (
      sessionID: string,
      requestID: string,
      reply: "once" | "always" | "reject",
    ): Promise<void> =>
      getClient().permission.reply({ sessionID, requestID, reply }),

    // -- forms -----------------------------------------------------------------
    formsList: async (
      sessionID?: string,
    ): Promise<Array<Record<string, unknown>>> => {
      if (sessionID) {
        const rows = await getClient().form.list({ sessionID });
        return rows as unknown as Array<Record<string, unknown>>;
      }
      const res = await getClient().form.request.list();
      return (res.data ?? []) as Array<Record<string, unknown>>;
    },
    formReply: async (
      sessionID: string,
      formID: string,
      answer: Record<string, string | number | boolean | ReadonlyArray<string>>,
    ): Promise<void> => {
      await getClient().form.reply({ sessionID, formID, answer });
    },
    formCancel: async (sessionID: string, formID: string): Promise<void> => {
      await getClient().form.cancel({ sessionID, formID });
    },

    // -- questions (V2 experimental) ------------------------------------------
    questionList: async (
      sessionID: string,
    ): Promise<Array<Record<string, unknown>>> => {
      // Pending questions are Location-owned in-memory state; the session-
      // scoped list can come back EMPTY while `/api/question/request` holds
      // the row (per the V2 schema changelog). Merge both and dedupe.
      const { Service } = await import("@opencode-ai/client/service");
      const endpoint = await Service.discover().catch(() => undefined);
      if (!endpoint) return [];
      const headers = Service.headers(endpoint) as unknown as Record<
        string,
        string
      >;
      const fetchList = async (
        url: string,
      ): Promise<Array<Record<string, unknown>>> => {
        try {
          const res = await fetch(url, { headers });
          if (!res.ok) return [];
          const data = (await res.json()) as unknown;
          const rows = Array.isArray(data)
            ? data
            : ((data as { data?: unknown[] }).data ?? []);
          return (Array.isArray(rows) ? rows : []) as Array<
            Record<string, unknown>
          >;
        } catch {
          return [];
        }
      };
      try {
        const [sessionRows, locationRows] = await Promise.all([
          fetchList(`${endpoint.url}/api/session/${sessionID}/question`),
          fetchList(`${endpoint.url}/api/question/request`),
        ]);
        const byId = new Map<string, Record<string, unknown>>();
        for (const row of [...locationRows, ...sessionRows]) {
          const id = typeof row.id === "string" ? row.id : "";
          byId.set(id || `_x${byId.size}`, row);
        }
        return [...byId.values()];
      } catch {
        return [];
      }
    },
    questionReply: async (
      sessionID: string,
      requestID: string,
      answers: string[][],
    ): Promise<void> => {
      const { Service } = await import("@opencode-ai/client/service");
      const endpoint = await Service.discover().catch(() => undefined);
      if (!endpoint)
        throw new Error("No service discovered for question reply");
      const url = `${endpoint.url}/api/session/${sessionID}/question/${requestID}/reply`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...(Service.headers(endpoint) as unknown as Record<string, string>),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // Verified live: the experimental question HTTP surface is ABSENT on
        // current betas (all question* routes 404, absent from live
        // openapi.json). Distinguish that from a bad request so the UI can
        // fall back to a steered prompt instead of showing a scary error.
        if (res.status === 404) {
          const e = new Error(text || "Question reply failed: 404") as Error & {
            code?: string;
          };
          e.code = "QuestionHTTPUnavailable";
          throw e;
        }
        throw new Error(text || `Question reply failed: ${res.status}`);
      }
    },

    // -- misc ----------------------------------------------------------------
    findFiles: async (
      query: string,
      directory?: string,
    ): Promise<Array<Record<string, unknown>>> => {
      // FileFindOutput is a raw {location,data} wrapper on this beta — the
      // @-mention picker consumed it bare and crashed into its own catch,
      // leaving mentions permanently empty.
      const res = await getClient().file.find({
        query,
        location: directory ? { directory } : undefined,
      });
      return asRows<Record<string, unknown>>(res);
    },
    fileRead: async (path: string): Promise<string> => {
      const res = await getClient().file.read({ path });
      const bytes =
        res instanceof Uint8Array ? res : new Uint8Array(res as ArrayBuffer);
      return new TextDecoder().decode(bytes).slice(0, 4000);
    },
    commands: async (): Promise<
      Array<{ name: string; description?: string }>
    > => {
      const res = await getClient().command.list();
      return (res.data ?? []).map((c) => ({
        name: c.name,
        description:
          typeof c.description === "string" ? c.description : undefined,
      }));
    },
    skills: async (): Promise<
      Array<{ name: string; description?: string; slash?: boolean }>
    > => {
      const res = await getClient().skill.list();
      return (res.data ?? []).map((s) => ({
        name: s.name,
        description:
          typeof s.description === "string" ? s.description : undefined,
        slash: s.slash === true,
      }));
    },
    sessionCommand: (
      sessionID: string,
      command: string,
      args?: string,
    ): Promise<unknown> =>
      // beta-18230 made `text` required: the rendered prompt body the TUI
      // would show for this invocation.
      getClient().session.command({
        sessionID,
        command,
        text: args ?? "",
        ...(args !== undefined && args.length > 0 ? { arguments: args } : {}),
      }),
    sessionSkill: (sessionID: string, skill: string): Promise<void> =>
      getClient().session.skill({ sessionID, skill }),
    defaultModel: async () => {
      const res = await getClient().model.default();
      return res.data;
    },
    mcpList: () => getClient().mcp.list(),
    /** Effective service config (merged layers) — exposes per-server mcp settings. */
    configGet: async (): Promise<Record<string, unknown>> => {
      const res = (await getClient().config.get()) as unknown as {
        data?: unknown;
      };
      const data = res?.data ?? res;
      return typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : {};
    },
    mcpResources: async (): Promise<Array<Record<string, unknown>>> => {
      // McpResourceCatalogOutput = {location, resources, templates} — the
      // drawer consumes the resources rows.
      const res = await getClient().mcp.resource.catalog();
      const cat = res as unknown as {
        resources?: unknown;
        data?: { resources?: unknown };
      };
      const rows = Array.isArray(cat?.resources)
        ? cat.resources
        : Array.isArray(cat?.data?.resources)
          ? cat.data.resources
          : [];
      return rows as Array<Record<string, unknown>>;
    },
    mcpAdd: (server: string, config: unknown) =>
      getClient().mcp.add({ server, config: config as never }),
    mcpRemove: (server: string) => getClient().mcp.remove({ server }),
    mcpConnect: (server: string) => getClient().mcp.connect({ server }),
    mcpDisconnect: (server: string) => getClient().mcp.disconnect({ server }),

    // -- instructions (project rules / /init) ---------------------------------
    instructionsList: async (
      sessionID: string,
    ): Promise<Array<Record<string, unknown>>> => {
      const res = await getClient().session.instructions.entry.list({
        sessionID,
      });
      return (
        Array.isArray(res)
          ? res
          : ((res as unknown as { data?: unknown[] }).data ?? [])
      ) as Array<Record<string, unknown>>;
    },
    instructionPut: (
      sessionID: string,
      key: string,
      value: unknown,
    ): Promise<void> =>
      getClient().session.instructions.entry.put({
        sessionID,
        key,
        value: value as never,
      }),
    instructionRemove: (sessionID: string, key: string): Promise<void> =>
      getClient().session.instructions.entry.remove({ sessionID, key }),

    // -- permissions: saved rules ---------------------------------------------
    savedPermissions: async (): Promise<Array<Record<string, unknown>>> => {
      const res = (await getClient().permission.saved.list()) as unknown;
      return Array.isArray(res)
        ? (res as Array<Record<string, unknown>>)
        : (((res as { data?: unknown[] }).data ?? []) as Array<
            Record<string, unknown>
          >);
    },
    savedPermissionRemove: (id: string): Promise<void> =>
      getClient().permission.saved.remove({ id }),

    // -- provider connect (in-app; replaces the CLI auth handoff) --------------
    integrationGet: async (
      integrationID: string,
    ): Promise<Record<string, unknown> | undefined> => {
      const res = await getClient().integration.get({ integrationID });
      return res.data as unknown as Record<string, unknown> | undefined;
    },
    credentialUpdate: (credentialID: string, label: string): Promise<void> =>
      getClient().credential.update({ credentialID, label }),
    credentialRemove: (credentialID: string): Promise<void> =>
      getClient().credential.remove({ credentialID }),
    pluginList: async (): Promise<Array<Record<string, unknown>>> => {
      const res = await getClient().plugin.list();
      return ((res.data ?? []) as unknown[]).map(
        (r) => r as Record<string, unknown>,
      );
    },
    websearchProviders: async (): Promise<Array<Record<string, unknown>>> => {
      const res = await getClient().websearch.providers();
      return ((res.data ?? []) as unknown[]).map(
        (r) => r as Record<string, unknown>,
      );
    },
    connectKey: (integrationID: string, key: string): Promise<void> =>
      getClient().integration.connect.key({ integrationID, key }),
    oauthConnect: async (
      integrationID: string,
      methodID?: string,
    ): Promise<{ attemptID?: string; url?: string }> => {
      // methodID is REQUIRED by the schema. When the caller doesn't know it,
      // resolve the integration's first OAuth method instead of sending a
      // schema-invalid request.
      let mid = methodID;
      if (!mid) {
        const info = await getClient().integration.get({ integrationID });
        const scan = JSON.stringify(info ?? {});
        try {
          const methods = JSON.parse(scan) as unknown;
          const found: string[] = [];
          const walk = (v: unknown): void => {
            if (!v || typeof v !== "object") return;
            if (Array.isArray(v)) {
              v.forEach(walk);
              return;
            }
            const rec = v as Record<string, unknown>;
            if (rec.type === "oauth" && typeof rec.id === "string")
              found.push(rec.id);
            for (const k of Object.values(rec)) walk(k);
          };
          walk(methods);
          mid = found[0];
        } catch {
          /* fall through — server will reject with its own error */
        }
      }
      const res = await getClient().integration.oauth.connect({
        integrationID,
        ...(mid ? { methodID: mid } : {}),
      } as never);
      const d = (res.data ?? {}) as Record<string, unknown>;
      return {
        attemptID: typeof d.attemptID === "string" ? d.attemptID : undefined,
        url: typeof d.url === "string" ? d.url : undefined,
      };
    },
    oauthStatus: async (
      integrationID: string,
      attemptID: string,
    ): Promise<Record<string, unknown>> => {
      const res = await getClient().integration.oauth.status({
        integrationID,
        attemptID,
      } as never);
      return (res.data ?? {}) as unknown as Record<string, unknown>;
    },
    oauthComplete: (integrationID: string, attemptID: string): Promise<void> =>
      getClient().integration.oauth.complete({
        integrationID,
        attemptID,
      } as never),
    oauthCancel: (integrationID: string, attemptID: string): Promise<void> =>
      getClient().integration.oauth.cancel({
        integrationID,
        attemptID,
      } as never),
    commandConnect: async (
      integrationID: string,
      methodID: string,
    ): Promise<{ attemptID?: string; instructions?: string }> => {
      const res = await getClient().integration.command.connect({
        integrationID,
        methodID,
      } as never);
      const d = (res.data ?? {}) as Record<string, unknown>;
      return {
        attemptID: typeof d.attemptID === "string" ? d.attemptID : undefined,
        instructions:
          typeof d.instructions === "string" ? d.instructions : undefined,
      };
    },

    // -- vcs -------------------------------------------------------------------
    vcsInfo: async (): Promise<{ branch?: string } | undefined> => {
      try {
        const res = await getClient().vcs.get();
        const info = res.data as unknown as
          { branch?: { name?: string; current?: string } | string } | undefined;
        if (!info?.branch) return undefined;
        if (typeof info.branch === "string") return { branch: info.branch };
        return { branch: info.branch.name ?? info.branch.current };
      } catch {
        return undefined;
      }
    },
    vcsDiff: async (
      mode: "working" | "branch",
      directory?: string,
    ): Promise<string> => {
      const res = await getClient().vcs.diff({
        mode,
        ...(directory ? { location: { directory } } : {}),
      } as never);
      const out = res.data as unknown;
      if (typeof out === "string") return out;
      // Current beta: data is FileDiffInfo[] ({file,patch,…}) — join patches.
      if (Array.isArray(out)) {
        return out
          .map((r) =>
            typeof (r as { patch?: unknown }).patch === "string"
              ? (r as { patch: string }).patch
              : "",
          )
          .filter(Boolean)
          .join("\n");
      }
      const rec = (out ?? {}) as Record<string, unknown>;
      return typeof rec.diff === "string"
        ? rec.diff
        : typeof rec.text === "string"
          ? rec.text
          : "";
    },

    // -- worktrees --------------------------------------------------------------
    worktreeList: async (
      projectID: string,
    ): Promise<Array<Record<string, unknown>>> => {
      const res = (await getClient().worktree.list({ projectID })) as unknown;
      return Array.isArray(res)
        ? (res as Array<Record<string, unknown>>)
        : (((res as { data?: unknown[] }).data ?? []) as Array<
            Record<string, unknown>
          >);
    },
    worktreeCreate: (
      projectID: string,
      opts: { from?: string; directory: string; name?: string },
    ): Promise<unknown> => {
      // Schema (verified vs OpenAPI): {strategy:string, directory:string,
      // from?, branch?, name?} — strategy is a flat REQUIRED string, not an
      // object; the old nested shape could never validate.
      const strategy = opts.from ? "from" : "directory";
      return getClient().worktree.create({
        projectID,
        strategy,
        directory: opts.directory,
        ...(opts.from ? { from: opts.from } : {}),
        ...(opts.name ? { name: opts.name } : {}),
      } as never);
    },
    worktreeRemove: (
      projectID: string,
      directory: string,
      force: boolean,
    ): Promise<void> =>
      getClient().worktree.remove({ projectID, directory, force } as never),
    worktreeRefresh: (projectID: string): Promise<void> =>
      getClient().worktree.refresh({ projectID }),
    providers: async () => {
      const [integrations, providers] = await Promise.all([
        getClient()
          .integration.list()
          .catch(() => undefined),
        getClient()
          .provider.list()
          .catch(() => undefined),
      ]);
      return {
        integrations: integrations?.data ?? [],
        providers: (providers?.data ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          activation: p.activation,
        })),
      };
    },
    projectCurrent: async (): Promise<Record<string, unknown> | undefined> => {
      const res = await getClient().project.current();
      return res as unknown as Record<string, unknown> | undefined;
    },
  };
}

export type Api = ReturnType<typeof createApi>;

/** Narrow an unknown event pushed over RPC into its `type` + payload. */
export interface WireEvent {
  type: string;
  sessionID?: string;
  raw: OpenCodeEvent;
}

export function toWireEvent(raw: OpenCodeEvent): WireEvent {
  const data = (raw as { data?: { sessionID?: string } }).data;
  return {
    type: (raw as { type?: string }).type ?? "unknown",
    sessionID: data?.sessionID,
    raw,
  };
}
