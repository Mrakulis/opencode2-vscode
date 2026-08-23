import * as vscode from "vscode";
import * as path from "node:path";
import { createApi } from "./apiAdapter";
import type { OpenCodeController } from "./controller";
import { isSettingKey, validateSettingValue, type RpcMethod, type RpcRequest } from "./protocol";
import { Log } from "./log";

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Host-side RPC dispatcher: routes webview requests to the api adapter.
 * Params are read defensively — the wire is a trust boundary.
 */
export function createRpcDispatcher(controller: OpenCodeController, log: Log) {
  const api = createApi({
    getClient: () => controller.getClient(),
  });

  let activeSessionId: string | undefined;
  /** Which session the webview is currently viewing (for notification routing). */
  const getActiveSessionId = (): string | undefined => activeSessionId;

  const str = (params: Record<string, unknown>, key: string): string => {
    const v = params[key];
    if (typeof v !== "string" || v.length === 0) throw new Error(`rpc: missing '${key}'`);
    return v;
  };
  const optStr = (params: Record<string, unknown>, key: string): string | undefined => {
    const v = params[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  /** Handlers may register incrementally; unknown methods are reported, not thrown. */
  const handlers: Partial<Record<RpcMethod, Handler>> = {
    "session.list": (p) => {
      const all = p.allProjects === true;
      return api.sessionList(all ? undefined : preferredDirectory());
    },
    "session.create": (p) => {
      const model = p.model as { id?: unknown; providerID?: unknown } | undefined;
      const parsed =
        typeof model?.id === "string" && typeof model?.providerID === "string"
          ? { id: model.id, providerID: model.providerID }
          : undefined;
      return api.sessionCreate({
        title: optStr(p, "title"),
        agent: optStr(p, "agent"),
        directory: optStr(p, "directory") ?? preferredDirectory(),
        ...(parsed ? { model: parsed } : {}),
      });
    },
    "session.remove": (p) => api.sessionRemove(str(p, "sessionID")),
    "session.rename": (p) => api.sessionRename(str(p, "sessionID"), str(p, "title")),
    "session.fork": (p) => api.fork(str(p, "sessionID")),
    "transcript.copy": (p) => {
      const text = str(p, "markdown");
      return Promise.resolve(vscode.env.clipboard.writeText(text));
    },
    "ui.activeSession": (p) => {
      const id = optStr(p, "id");
      activeSessionId = id;
      log.debug(`active session reported: ${id ?? "(none)"}`);
      return Promise.resolve();
    },
    "messages.list": (p) => api.messages(str(p, "sessionID")),
    "prompt.send": (p) =>
      api.prompt({
        sessionID: str(p, "sessionID"),
        text: str(p, "text"),
        delivery: p.delivery === "steer" || p.delivery === "queue" ? p.delivery : undefined,
      }),
    "prompt.interrupt": (p) => api.interrupt(str(p, "sessionID")),
    "session.compact": (p) => api.compact(str(p, "sessionID")),
    "models.list": () => api.models(),
    "agents.list": () => api.agents(),
    "model.switch": (p) => {
      const model = p.model as { id?: unknown; providerID?: unknown; variant?: unknown } | undefined;
      if (typeof model?.id !== "string" || typeof model?.providerID !== "string") {
        throw new Error("rpc: missing 'model.id'/'model.providerID'");
      }
      const variant = typeof model.variant === "string" && model.variant.length > 0 ? model.variant : undefined;
      return api.switchModel(str(p, "sessionID"), {
        id: model.id,
        providerID: model.providerID,
        ...(variant ? { variant } : {}),
      });
    },
    "agent.switch": (p) => api.switchAgent(str(p, "sessionID"), str(p, "agent")),
    "permissions.pending": () => api.pendingPermissions(),
    "permission.reply": (p) =>
      api.replyPermission(
        str(p, "sessionID"),
        str(p, "requestID"),
        p.reply === "always" || p.reply === "reject" ? p.reply : "once",
      ),
    "files.find": (p) => api.findFiles(str(p, "query"), optStr(p, "directory")),
    "workspace.directory": async () => preferredDirectory(),
    "settings.update": (p) => {
      const updates = p.updates as Array<{ key?: unknown; value?: unknown }> | undefined;
      if (!Array.isArray(updates)) throw new Error("rpc: 'updates' must be an array");
      const cfg = vscode.workspace.getConfiguration("opencode2");
      for (const u of updates) {
        const key = typeof u?.key === "string" ? u.key : "";
        if (!isSettingKey(key)) throw new Error(`rpc: unsupported setting '${key}'`);
        const check = validateSettingValue(key, u.value);
        if (!check.ok) throw new Error(`rpc: ${check.reason}`);
        void cfg.update(key, u.value, vscode.ConfigurationTarget.Global);
      }
      return Promise.resolve(true);
    },
    "models.default": () => api.defaultModel(),
    "providers.list": () => api.providers(),
    "mcp.list": () => api.mcpList(),
    "mcp.add": (p) => {
      const name = str(p, "name");
      const config = p.config as Record<string, unknown> | undefined;
      if (!config || typeof config !== "object") throw new Error("rpc: missing 'config'");
      return api.mcpAdd(name, config);
    },
    "mcp.remove": (p) => api.mcpRemove(str(p, "name")),
    "mcp.connect": (p) => api.mcpConnect(str(p, "name")),
    "mcp.disconnect": (p) => api.mcpDisconnect(str(p, "name")),
    "mcp.resources": () => api.mcpResources(),
    "providers.authCli": (p) => {
      const name = optStr(p, "name");
      const terminal = vscode.window.createTerminal({ name: "OpenCode 2 — connect provider" });
      terminal.show();
      terminal.sendText(`opencode2 auth login${name ? ` ${name}` : ""}`, true);
      log.info(`provider auth handoff: opencode2 auth login${name ? ` ${name}` : ""}`);
      return Promise.resolve(true);
    },
    "file.open": async (p) => {
      const raw = str(p, "path");
      // handle file:line or file:line:col suffix
      const m = raw.match(/^(.+?):(\d+)(?::(\d+))?$/);
      const filePart: string = m?.[1] ?? raw;
      const line = m?.[2] ? parseInt(m[2], 10) : undefined;
      const col = m?.[3] ? parseInt(m[3], 10) : undefined;
      // resolve relative to workspace
      let uri: vscode.Uri;
      if (/^[a-zA-Z]:[\\/]/.test(filePart) || filePart.startsWith("/") || filePart.startsWith("\\")) {
        uri = vscode.Uri.file(filePart);
      } else {
        const base = preferredDirectory() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!base) throw new Error(`Cannot resolve relative path: ${raw}`);
        const joined = path.join(base, filePart);
        uri = vscode.Uri.file(joined);
      }
      // try to open, reveal line
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (line !== undefined) {
        const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, (col ?? 1) - 1));
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      return true;
    },
    "diff.open": async (p) => {
      const file = str(p, "file");
      const diff = str(p, "diff");
      // show diff as a diff-language document
      const doc = await vscode.workspace.openTextDocument({ language: "diff", content: diff });
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });
      // also try to open the actual file alongside for reference
      try {
        const base = preferredDirectory() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let fileUri: vscode.Uri;
        if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith("/") || file.startsWith("\\")) fileUri = vscode.Uri.file(file);
        else if (base) fileUri = vscode.Uri.file(path.join(base, file));
        else throw new Error("no base");
        // open as second editor if file exists
        await vscode.workspace.openTextDocument(fileUri).then(
          () => vscode.commands.executeCommand("workbench.action.splitEditor"),
          () => undefined,
        );
      } catch {}
      return true;
    },
  };

  /** Handle one request; never throws — failures become RpcResponse errors. */
  async function handle(request: RpcRequest): Promise<{ id: number; ok: boolean; result?: unknown; error?: string }> {
    const handler = handlers[request.method] as Handler | undefined;
    if (!handler) {
      return { id: request.id, ok: false, error: `Unknown rpc method: ${String(request.method)}` };
    }
    try {
      const result = await handler(request.params ?? {});
      return { id: request.id, ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`rpc ${request.method} failed`, error);
      return { id: request.id, ok: false, error: message };
    }
  }

  return {
    handle,
    getActiveSessionId,
  };
}

/** Multi-root: prefer the workspace folder of the focused editor, else first. */
function preferredDirectory(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder.uri.fsPath;
  }
  const fallback =
    vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file") ??
    vscode.workspace.workspaceFolders?.[0];
  return fallback?.uri.fsPath;
}

export type RpcDispatcher = ReturnType<typeof createRpcDispatcher>;
