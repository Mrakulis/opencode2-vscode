import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createApi } from "./apiAdapter";
import type { ResolvedCli } from "./cli";
import type { OpenCodeController } from "./controller";
import { isSettingKey, validateSettingValue, type RpcMethod, type RpcRequest } from "./protocol";
import { Log } from "./log";

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Host-side RPC dispatcher: routes webview requests to the api adapter.
 * Params are read defensively — the wire is a trust boundary.
 */
export function createRpcDispatcher(controller: OpenCodeController, log: Log, resolveCli?: () => Promise<ResolvedCli | undefined>) {
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
    "prompt.send": (p) => {
      const rawFiles = p.files as unknown;
      let files: Array<{ uri: string; name?: string }> | undefined;
      if (Array.isArray(rawFiles)) {
        files = rawFiles
          .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null && typeof (f as Record<string, unknown>).uri === "string")
          .map((f) => {
            const rec = f as Record<string, unknown>;
            return { uri: rec.uri as string, ...(typeof rec.name === "string" ? { name: rec.name } : {}) };
          });
        if (files.length === 0) files = undefined;
      }
      const text = typeof p.text === "string" ? p.text : "";
      if (!text && !files) throw new Error("rpc: missing 'text' or 'files'");
      return api.prompt({
        sessionID: str(p, "sessionID"),
        text,
        ...(files ? { files } : {}),
        delivery: p.delivery === "steer" || p.delivery === "queue" ? p.delivery : undefined,
      });
    },
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
    "commands.list": () => api.commands(),
    "skills.list": () => api.skills(),
    "session.command": (p) => {
      const command = str(p, "command");
      const args = p.args as unknown;
      return api.sessionCommand(str(p, "sessionID"), command, typeof args === "string" ? args : undefined);
    },
    "session.skill": (p) => api.sessionSkill(str(p, "sessionID"), str(p, "name")),
    "forms.pending": (p) => api.formsList(optStr(p, "sessionID")),
    "form.reply": (p) => {
      const answer = p.answer as Record<string, unknown> | undefined;
      if (!answer || typeof answer !== "object") throw new Error("rpc: missing 'answer'");
      const clean: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
      for (const [k, v] of Object.entries(answer)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") clean[k] = v;
        else if (Array.isArray(v) && v.every((x) => typeof x === "string")) clean[k] = v as string[];
      }
      return api.formReply(str(p, "sessionID"), str(p, "formID"), clean);
    },
    "form.cancel": (p) => api.formCancel(str(p, "sessionID"), str(p, "formID")),

    // -- session parity ---------------------------------------------------------
    "session.export": (p) => api.exportSession(str(p, "sessionID")),
    "session.import": (p) => {
      if (typeof p.payload !== "object" || p.payload === null) throw new Error("rpc: missing 'payload'");
      return api.importSession(p.payload);
    },
    "session.move": (p) => api.moveSession(str(p, "sessionID"), str(p, "directory")),
    "session.revert.stage": (p) => {
      const files = p.files as unknown;
      return api.revertStage(str(p, "sessionID"), str(p, "messageID"), typeof files === "boolean" ? files : undefined);
    },
    "session.revert.clear": (p) => api.revertClear(str(p, "sessionID")),
    "session.revert.commit": (p) => api.revertCommit(str(p, "sessionID")),
    "session.context": (p) => api.sessionContext(str(p, "sessionID")),
    "inbox.list": (p) => api.inboxList(str(p, "sessionID")),
    "inbox.cancel": (p) => api.inboxCancel(str(p, "sessionID"), str(p, "inboxID")),
    "inbox.steer": (p) => api.inboxSteer(str(p, "sessionID"), str(p, "inboxID")),
    "inbox.queue": (p) => api.inboxQueue(str(p, "sessionID"), str(p, "inboxID")),

    // -- instructions -----------------------------------------------------------
    "instructions.list": (p) => api.instructionsList(str(p, "sessionID")),
    "instructions.put": (p) => api.instructionPut(str(p, "sessionID"), str(p, "key"), p.value),
    "instructions.remove": (p) => api.instructionRemove(str(p, "sessionID"), str(p, "key")),

    // -- saved permissions -------------------------------------------------------
    "permissions.saved": () => api.savedPermissions(),
    "permissions.saved.remove": (p) => api.savedPermissionRemove(str(p, "id")),

    // -- provider connect ---------------------------------------------------------
    "integration.get": (p) => api.integrationGet(str(p, "integrationID")),
    "integration.connectKey": (p) => api.connectKey(str(p, "integrationID"), str(p, "key")),
    "integration.oauthConnect": (p) => {
      const methodID = optStr(p, "methodID");
      return api.oauthConnect(str(p, "integrationID"), methodID);
    },
    "integration.oauthStatus": (p) => api.oauthStatus(str(p, "integrationID"), str(p, "attemptID")),
    "integration.oauthComplete": (p) => api.oauthComplete(str(p, "integrationID"), str(p, "attemptID")),
    "integration.oauthCancel": (p) => api.oauthCancel(str(p, "integrationID"), str(p, "attemptID")),
    "integration.commandConnect": (p) => api.commandConnect(str(p, "integrationID"), str(p, "methodID")),
    "credentials.update": (p) => api.credentialUpdate(str(p, "credentialID"), str(p, "label")),
    "credentials.remove": (p) => api.credentialRemove(str(p, "credentialID")),
    "plugins.list": () => api.pluginList(),
    "websearch.providers": () => api.websearchProviders(),

    // -- vcs & worktrees ------------------------------------------------------------
    "vcs.info": () => api.vcsInfo(),
    "vcs.diff": (p) => {
      const mode = p.mode === "branch" ? "branch" : "working";
      return api.vcsDiff(mode, optStr(p, "directory"));
    },
    "worktree.list": (p) => api.worktreeList(str(p, "projectID")),
    "worktree.create": (p) => {
      const directory = str(p, "directory");
      const name = optStr(p, "name");
      const from = optStr(p, "from");
      return api.worktreeCreate(str(p, "projectID"), { directory, ...(name ? { name } : {}), ...(from ? { from } : {}) });
    },
    "worktree.remove": (p) => api.worktreeRemove(str(p, "projectID"), str(p, "directory"), p.force === true),
    "worktree.refresh": (p) => api.worktreeRefresh(str(p, "projectID")),
    "workspace.directory": async () => preferredDirectory(),
    "pick.folder": async () => {
      const pick = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Move session to which folder?" });
      return pick?.uri.fsPath;
    },
    "project.current": async () => {
      try {
        const res = await api.projectCurrent();
        return res;
      } catch {
        return undefined;
      }
    },
    "dialog.saveText": async (p) => {
      const content = str(p, "content");
      const suggested = optStr(p, "suggestedName") ?? "export.json";
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(suggested) });
      if (!uri) return { saved: false };
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      return { saved: true, path: uri.fsPath };
    },
    "dialog.openText": async (p) => {
      const filters = (p.filters as Record<string, string[]> | undefined) ?? { "Session export": ["json"] };
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters });
      if (!uris || uris.length === 0) return undefined;
      const doc = await vscode.workspace.openTextDocument(uris[0]!);
      return doc.getText();
    },
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
    "providers.authCli": async (p) => {
      // Use the actually-resolved binary (opencode2 on this machine, opencode
      // for npm-only installs) instead of a hard-coded name.
      const resolved = resolveCli ? await resolveCli() : undefined;
      const bin = resolved ? resolved.program.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? "opencode2" : "opencode2";
      const name = optStr(p, "name");
      const terminal = vscode.window.createTerminal({ name: "OpenCode 2 — connect provider" });
      terminal.show();
      terminal.sendText(`${bin} auth login${name ? ` ${name}` : ""}`, true);
      log.info(`provider auth handoff: ${bin} auth login${name ? ` ${name}` : ""}`);
      return true;
    },
    "settings.open": async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "opencode2");
      return true;
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
      const diff = optStr(p, "diff") ?? "";
      if (diff) {
        const doc = await vscode.workspace.openTextDocument({ language: "diff", content: diff });
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active });
        return true;
      }
      // No diff string: open whole-file diff via VS Code's git provider (shows full file)
      const base = preferredDirectory() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let fileUri: vscode.Uri;
      if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith("/") || file.startsWith("\\")) fileUri = vscode.Uri.file(file);
      else if (base) fileUri = vscode.Uri.file(path.join(base, file));
      else throw new Error("no base");
      try {
        const gitUri = fileUri.with({ scheme: "git", query: JSON.stringify({ path: fileUri.fsPath, ref: "HEAD" }) });
        await vscode.commands.executeCommand("vscode.diff", gitUri, fileUri, `${path.basename(fileUri.fsPath)} ↔ Working Tree`);
        return true;
      } catch {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        return true;
      }
    },
    "image.save": async (p) => {
      const data = str(p, "data");
      const name = optStr(p, "name") ?? `pasted-${Date.now()}.png`;
      // mime not strictly needed, keep for future
      const dir = path.join(os.tmpdir(), "opencode-images");
      await fs.promises.mkdir(dir, { recursive: true });
      // sanitize name
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(dir, `${Date.now()}-${safe}`);
      const buf = Buffer.from(data, "base64");
      await fs.promises.writeFile(filePath, buf);
      return { uri: filePath, name: safe };
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
