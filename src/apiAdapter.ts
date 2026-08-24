import type {
  AgentInfo,
  ModelInfo,
  OpenCodeClient,
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode-ai/client";
import path from "node:path";

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
      return res.data;
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
    interrupt: (sessionID: string): Promise<void> =>
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

    // -- pickers -------------------------------------------------------------
    models: async (): Promise<Array<ModelInfo & { context: number }>> => {
      const res = await getClient().model.list();
      return res.data
        .filter((m) => m.enabled)
        .map((m) => ({
          ...m,
          // normalize: downstream expects top-level `context` = limit.context
          // and `id` consistent with ModelRef (modelID is canonical)
          id: (m as unknown as { modelID?: string }).modelID ?? m.id,
          context: m.limit.context,
        })) as Array<ModelInfo & { context: number }>;
    },
    agents: async (): Promise<AgentInfo[]> => {
      const res = await getClient().agent.list();
      return res.data.filter((a) => !a.hidden && a.mode !== "subagent");
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

    // -- misc ----------------------------------------------------------------
    findFiles: (query: string, directory?: string) =>
      getClient().file.find({
        query,
        location: directory ? { directory } : undefined,
      }),
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
      getClient().session.command({
        sessionID,
        command,
        ...(args !== undefined && args.length > 0 ? { arguments: args } : {}),
      }),
    sessionSkill: (sessionID: string, skill: string): Promise<void> =>
      getClient().session.skill({ sessionID, skill }),
    defaultModel: async () => {
      const res = await getClient().model.default();
      return res.data;
    },
    mcpList: () => getClient().mcp.list(),
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
      const res = await getClient().integration.oauth.connect({
        integrationID,
        ...(methodID ? { methodID } : {}),
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
    ): Promise<unknown> =>
      getClient().worktree.create({
        projectID,
        strategy: {
          ...(opts.from ? { from: opts.from } : {}),
          directory: opts.directory,
          ...(opts.name ? { name: opts.name } : {}),
        },
      } as never),
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
