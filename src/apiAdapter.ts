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
      const res = await getClient().session.list(
        directory ? { directory } : undefined,
      );
      const root = directory ? path.normalize(directory).toLowerCase() : undefined;
      let data = res.data;
      if (root) {
        data = data.filter((s) => {
          const dir = s.location?.directory ? path.normalize(s.location.directory).toLowerCase() : undefined;
          return dir !== undefined && (dir === root || dir.startsWith(root + path.sep));
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
    sessionGet: (sessionID: string): Promise<SessionInfo> => getClient().session.get({ sessionID }),
    sessionRemove: (sessionID: string): Promise<void> => getClient().session.remove({ sessionID }),
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
      files?: Array<{ uri: string; name?: string; mention?: { start: number; end: number; text: string } }>;
      delivery?: "steer" | "queue";
    }): Promise<unknown> =>
      getClient().session.prompt({
        sessionID: input.sessionID,
        text: input.text,
        files: input.files,
        delivery: input.delivery,
      }),
    interrupt: (sessionID: string): Promise<void> => getClient().session.interrupt({ sessionID }),
    compact: (sessionID: string): Promise<unknown> => getClient().session.compact({ sessionID }),
    fork: (sessionID: string): Promise<SessionInfo> =>
      getClient().session.fork({ sessionID, boundary: { type: "through" } }),

    // -- pickers -------------------------------------------------------------
    models: async (): Promise<ModelInfo[]> => {
      const res = await getClient().model.list();
      return res.data.filter((m) => m.enabled);
    },
    agents: async (): Promise<AgentInfo[]> => {
      const res = await getClient().agent.list();
      return res.data.filter((a) => !a.hidden && a.mode !== "subagent");
    },
    switchModel: (sessionID: string, model: { id: string; providerID: string }): Promise<void> =>
      getClient().session.switchModel({ sessionID, model }),
    switchAgent: (sessionID: string, agent: string): Promise<void> =>
      getClient().session.switchAgent({ sessionID, agent }),

    // -- permissions ---------------------------------------------------------
    pendingPermissions: () => getClient().permission.request.list(),
    replyPermission: (
      sessionID: string,
      requestID: string,
      reply: "once" | "always" | "reject",
    ): Promise<void> => getClient().permission.reply({ sessionID, requestID, reply }),

    // -- misc ----------------------------------------------------------------
    findFiles: (query: string, directory?: string) => getClient().file.find({ query, location: directory ? { directory } : undefined }),
    defaultModel: async () => {
      const res = await getClient().model.default();
      return res.data;
    },
    mcpList: () => getClient().mcp.list(),
    mcpAdd: (server: string, config: unknown) => getClient().mcp.add({ server, config: config as never }),
    mcpRemove: (server: string) => getClient().mcp.remove({ server }),
    mcpConnect: (server: string) => getClient().mcp.connect({ server }),
    mcpDisconnect: (server: string) => getClient().mcp.disconnect({ server }),
    mcpResources: () => getClient().mcp.resource.catalog(),
    providers: async () => {
      const [integrations, providers] = await Promise.all([
        getClient().integration.list().catch(() => undefined),
        getClient().provider.list().catch(() => undefined),
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
