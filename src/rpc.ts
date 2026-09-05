import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createApi } from "./apiAdapter";
import { canonicalizeDirectory } from "./directory";
import { DiffPreviewDocs, type WireFileDiff } from "./diffDocs";
import { WorkingDiffDocs } from "./workingDiffDocs";
import { resolveCli as resolveCliImpl } from "./cli";
import type { ResolvedCli } from "./cli";
import type { OpenCodeController } from "./controller";
import type { ExtensionServer } from "./extensionServer";
import { readListenConfig } from "./extensionServer";
import {
  isSettingKey,
  validateSettingValue,
  type RpcMethod,
  type RpcRequest,
} from "./protocol";
import { Log } from "./log";

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Host-side RPC dispatcher: routes webview requests to the api adapter.
 * Params are read defensively — the wire is a trust boundary.
 */
export function createRpcDispatcher(
  controller: OpenCodeController,
  log: Log,
  resolveCli?: () => Promise<ResolvedCli | undefined>,
  storage?: vscode.Memento,
  companion?: ExtensionServer,
) {
  const api = createApi({
    getClient: () => controller.getClient(),
  });
  const diffPreview = new DiffPreviewDocs();
  const workingDiffDocs = new WorkingDiffDocs();

  let activeSessionId: string | undefined;
  /** Which session the webview is currently viewing (for notification routing). */
  const getActiveSessionId = (): string | undefined => activeSessionId;

  const str = (params: Record<string, unknown>, key: string): string => {
    const v = params[key];
    if (typeof v !== "string" || v.length === 0)
      throw new Error(`rpc: missing '${key}'`);
    return v;
  };
  const optStr = (
    params: Record<string, unknown>,
    key: string,
  ): string | undefined => {
    const v = params[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const num = (params: Record<string, unknown>, key: string): number => {
    const v = params[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
      return Number(v);
    throw new Error(`rpc: missing numeric '${key}'`);
  };
  const optNum = (
    params: Record<string, unknown>,
    key: string,
  ): number | undefined => {
    const v = params[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
      return Number(v);
    return undefined;
  };

  /** Handlers may register incrementally; unknown methods are reported, not thrown. */
  const handlers: Partial<Record<RpcMethod, Handler>> = {
    "session.list": (p) => {
      const all = p.allProjects === true;
      return api.sessionList(all ? undefined : preferredDirectory());
    },
    "session.create": (p) => {
      const model = p.model as
        { id?: unknown; providerID?: unknown } | undefined;
      const parsed =
        typeof model?.id === "string" && typeof model?.providerID === "string"
          ? { id: model.id, providerID: model.providerID }
          : undefined;
      const directory = optStr(p, "directory") ?? preferredDirectory();
      return api.sessionCreate({
        title: optStr(p, "title"),
        agent: optStr(p, "agent"),
        ...(directory ? { directory: canonicalizeDirectory(directory) } : {}),
        ...(parsed ? { model: parsed } : {}),
      });
    },
    "session.remove": (p) => api.sessionRemove(str(p, "sessionID")),
    "session.rename": (p) =>
      api.sessionRename(str(p, "sessionID"), str(p, "title")),
    "session.fork": (p) => api.fork(str(p, "sessionID")),
    "sessions.active": () => api.sessionActive(),
    "session.view": (p) => api.sessionView(str(p, "sessionID"), num(p, "idle")),
    "session.stats": (p) => {
      const project = optStr(p, "project");
      const from = optNum(p, "from");
      const to = optNum(p, "to");
      const timezone = optStr(p, "timezone");
      const hasRange = from !== undefined || to !== undefined || timezone !== undefined;
      if (project || hasRange) {
        return api.sessionStats({
          ...(project ? { project } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          ...(timezone ? { timezone } : {}),
        });
      }
      return api.sessionStats(undefined);
    },
    "transcript.copy": (p) => {
      const text = str(p, "markdown");
      return Promise.resolve(vscode.env.clipboard.writeText(text));
    },
    "ui.activeSession": (p) => {
      const id = optStr(p, "id");
      activeSessionId = id;
      // Persist for restore-after-reload (webview reconnects to the same session).
      if (id) void storage?.update("lastSession", id);
      log.debug(`active session reported: ${id ?? "(none)"}`);
      return Promise.resolve();
    },
    "ui.lastModel": () =>
      Promise.resolve(
        storage?.get<{ id: string; providerID: string } | undefined>(
          "lastModel",
        ),
      ),
    "ui.lastModel.set": (p) => {
      const id = str(p, "id");
      const providerID = str(p, "providerID");
      void storage?.update("lastModel", { id, providerID });
      return Promise.resolve();
    },
    "messages.list": (p) => api.messages(str(p, "sessionID")),
    "prompt.send": (p) => {
      const rawFiles = p.files as unknown;
      let files: Array<{ uri: string; name?: string }> | undefined;
      if (Array.isArray(rawFiles)) {
        files = rawFiles
          .filter(
            (f): f is Record<string, unknown> =>
              typeof f === "object" &&
              f !== null &&
              typeof (f as Record<string, unknown>).uri === "string",
          )
          .map((f) => {
            const rec = f as Record<string, unknown>;
            return {
              uri: rec.uri as string,
              ...(typeof rec.name === "string" ? { name: rec.name } : {}),
            };
          });
        if (files.length === 0) files = undefined;
      }
      const text = typeof p.text === "string" ? p.text : "";
      if (!text && !files) throw new Error("rpc: missing 'text' or 'files'");
      return api.prompt({
        sessionID: str(p, "sessionID"),
        text,
        ...(files ? { files } : {}),
        delivery:
          p.delivery === "steer" || p.delivery === "queue"
            ? p.delivery
            : undefined,
      });
    },
    "prompt.interrupt": async (p) => {
      const sessionID = str(p, "sessionID");
      await api.interrupt(sessionID);
      // Wait for the run to fully settle so the answer the user sends next
      // starts a clean new turn instead of inheriting the interrupted step.
      // `session.wait` throws when there is nothing left to wait for — that's
      // fine; the interrupt already did its job.
      await api.sessionWait(sessionID).catch(() => {});
    },
    "session.compact": (p) => api.compact(str(p, "sessionID")),
    "models.list": () => api.models(),
    "agents.list": () => api.agents(),
    "model.switch": (p) => {
      const model = p.model as
        { id?: unknown; providerID?: unknown; variant?: unknown } | undefined;
      if (
        typeof model?.id !== "string" ||
        typeof model?.providerID !== "string"
      ) {
        throw new Error("rpc: missing 'model.id'/'model.providerID'");
      }
      const variant =
        typeof model.variant === "string" && model.variant.length > 0
          ? model.variant
          : undefined;
      return api.switchModel(str(p, "sessionID"), {
        id: model.id,
        providerID: model.providerID,
        ...(variant ? { variant } : {}),
      });
    },
    "agent.switch": (p) =>
      api.switchAgent(str(p, "sessionID"), str(p, "agent")),
    "permissions.pending": () => api.pendingPermissions(),
    "permission.reply": (p) =>
      api.replyPermission(
        str(p, "sessionID"),
        str(p, "requestID"),
        p.reply === "always" || p.reply === "reject" ? p.reply : "once",
      ),
    "files.find": (p) => {
      const dir = optStr(p, "directory");
      return api.findFiles(
        str(p, "query"),
        dir ? canonicalizeDirectory(dir) : undefined,
      );
    },
    "service.restart": () => controller.restart({ force: true }),
    "cli.start": async () => {
      // Strictly opencode2 — never fall back to legacy `opencode` (v1).
      const log = new Log();
      const cli = await resolveCliImpl(log);
      if (!cli)
        throw new Error(
          "OpenCode CLI (opencode2) not found — install via `npm i -g opencode-ai@beta` or set opencode2.cliPath",
        );
      if (
        !cli.display.includes("opencode2") &&
        !cli.program.includes("opencode2")
      ) {
        throw new Error(
          `Resolved CLI is not opencode2: ${cli.display} — please install opencode2`,
        );
      }
      await controller.connect(undefined, { force: true });
      return true;
    },
    // Bespoke plan-checklist support (local file; no V2 server contract).
    "plan.read": async () => {
      const base = preferredDirectory() ?? process.cwd();
      const candidates = [
        path.join(base, "implementation_plan.md"),
        path.join(base, ".opencode", "implementation_plan.md"),
      ];
      for (const p of candidates) {
        try {
          const content = await fs.promises.readFile(p, "utf8");
          return { path: p, content };
        } catch {
          /* try the next candidate */
        }
      }
      return { path: undefined, content: undefined };
    },
    "plan.save": async (p) => {
      const filePath = str(p, "path");
      const content = str(p, "content");
      const base = preferredDirectory() ?? process.cwd();
      const resolved = path.resolve(base, filePath);
      const baseNorm = path.resolve(base);
      if (resolved !== baseNorm && !resolved.startsWith(baseNorm + path.sep))
        throw new Error("rpc: plan.save path escapes workspace");
      await fs.promises.writeFile(resolved, content, "utf8");
      return true;
    },
    "file.read": (p) => api.fileRead(str(p, "path")),
    "commands.list": () => api.commands(),
    "skills.list": () => api.skills(),
    "session.command": (p) => {
      const command = str(p, "command");
      const args = p.args as unknown;
      return api.sessionCommand(
        str(p, "sessionID"),
        command,
        typeof args === "string" ? args : undefined,
      );
    },
    "session.skill": (p) =>
      api.sessionSkill(str(p, "sessionID"), str(p, "name")),
    "forms.pending": (p) => api.formsList(optStr(p, "sessionID")),
    "form.reply": (p) => {
      const answer = p.answer as Record<string, unknown> | undefined;
      if (!answer || typeof answer !== "object")
        throw new Error("rpc: missing 'answer'");
      const clean: Record<
        string,
        string | number | boolean | ReadonlyArray<string>
      > = {};
      for (const [k, v] of Object.entries(answer)) {
        if (
          typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean"
        )
          clean[k] = v;
        else if (Array.isArray(v) && v.every((x) => typeof x === "string"))
          clean[k] = v as string[];
      }
      return api.formReply(str(p, "sessionID"), str(p, "formID"), clean);
    },
    "form.cancel": (p) => api.formCancel(str(p, "sessionID"), str(p, "formID")),
    // -- session parity ---------------------------------------------------------
    "session.export": (p) => api.exportSession(str(p, "sessionID")),
    "session.import": (p) => {
      if (typeof p.payload !== "object" || p.payload === null)
        throw new Error("rpc: missing 'payload'");
      return api.importSession(p.payload);
    },
    "session.move": (p) =>
      api.moveSession(
        str(p, "sessionID"),
        canonicalizeDirectory(str(p, "directory")),
      ),
    "session.revert.stage": (p) => {
      const files = p.files as unknown;
      return api.revertStage(
        str(p, "sessionID"),
        str(p, "messageID"),
        typeof files === "boolean" ? files : undefined,
      );
    },
    "session.revert.clear": (p) => api.revertClear(str(p, "sessionID")),
    "session.revert.commit": (p) => api.revertCommit(str(p, "sessionID")),
    "session.context": (p) => api.sessionContext(str(p, "sessionID")),
    "inbox.list": (p) => api.inboxList(str(p, "sessionID")),
    "inbox.cancel": (p) =>
      api.inboxCancel(str(p, "sessionID"), str(p, "inboxID")),
    "inbox.steer": (p) =>
      api.inboxSteer(str(p, "sessionID"), str(p, "inboxID")),
    "inbox.queue": (p) =>
      api.inboxQueue(str(p, "sessionID"), str(p, "inboxID")),

    // -- instructions -----------------------------------------------------------
    "instructions.list": (p) => api.instructionsList(str(p, "sessionID")),
    "instructions.put": (p) =>
      api.instructionPut(str(p, "sessionID"), str(p, "key"), p.value),
    "instructions.remove": (p) =>
      api.instructionRemove(str(p, "sessionID"), str(p, "key")),

    // -- saved permissions -------------------------------------------------------
    "permissions.saved": () => api.savedPermissions(),
    "permissions.saved.remove": (p) => api.savedPermissionRemove(str(p, "id")),

    // -- provider connect ---------------------------------------------------------
    "integration.get": (p) => api.integrationGet(str(p, "integrationID")),
    "integration.connectKey": (p) =>
      api.connectKey(str(p, "integrationID"), str(p, "key")),
    "integration.oauthConnect": (p) => {
      const methodID = optStr(p, "methodID");
      return api.oauthConnect(str(p, "integrationID"), methodID);
    },
    "integration.oauthStatus": (p) =>
      api.oauthStatus(str(p, "integrationID"), str(p, "attemptID")),
    "integration.oauthComplete": (p) =>
      api.oauthComplete(str(p, "integrationID"), str(p, "attemptID")),
    "integration.oauthCancel": (p) =>
      api.oauthCancel(str(p, "integrationID"), str(p, "attemptID")),
    "integration.commandConnect": (p) =>
      api.commandConnect(str(p, "integrationID"), str(p, "methodID")),
    "credentials.update": (p) =>
      api.credentialUpdate(str(p, "credentialID"), str(p, "label")),
    "credentials.remove": (p) => api.credentialRemove(str(p, "credentialID")),
    "plugins.list": () => api.pluginList(),
    "websearch.providers": () => api.websearchProviders(),

    // -- vcs & worktrees ------------------------------------------------------------
    "vcs.info": (p) => {
      const dir = optStr(p, "directory");
      return api.vcsInfo(dir ? canonicalizeDirectory(dir) : undefined);
    },
    "vcs.status": (p) => {
      const dir = optStr(p, "directory");
      return api.vcsStatus(dir ? canonicalizeDirectory(dir) : undefined);
    },
    "vcs.diff": (p) => {
      const mode = p.mode === "branch" ? "branch" : "working";
      const dir = optStr(p, "directory");
      return api.vcsDiff(
        mode,
        dir ? canonicalizeDirectory(dir) : undefined,
      );
    },
    "worktree.list": (p) => {
      const scope = optStr(p, "scope") ?? preferredDirectory();
      return api.worktreeList(scope ? canonicalizeDirectory(scope) : undefined);
    },
    "worktree.create": (p) => {
      const directory = canonicalizeDirectory(str(p, "directory"));
      const name = optStr(p, "name");
      const from = optStr(p, "from");
      const scope = optStr(p, "scope") ?? preferredDirectory();
      return api.worktreeCreate(
        scope ? canonicalizeDirectory(scope) : undefined,
        {
          directory,
          ...(name ? { name } : {}),
          ...(from ? { from } : {}),
        },
      );
    },
    "worktree.remove": (p) => {
      const scope = optStr(p, "scope") ?? preferredDirectory();
      return api.worktreeRemove(
        scope ? canonicalizeDirectory(scope) : undefined,
        canonicalizeDirectory(str(p, "directory")),
        p.force === true,
      );
    },
    "worktree.refresh": (p) => {
      const scope = optStr(p, "scope") ?? preferredDirectory();
      return api.worktreeRefresh(
        scope ? canonicalizeDirectory(scope) : undefined,
      );
    },
    "workspace.directory": async () => preferredDirectory(),
    "pick.folder": async () => {
      const pick = await vscode.window.showWorkspaceFolderPick({
        placeHolder: "Move session to which folder?",
      });
      return pick?.uri.fsPath;
    },
    "project.current": async (p) => {
      try {
        const dir = optStr(p, "directory");
        const res = await api.projectCurrent(
          dir ? canonicalizeDirectory(dir) : undefined,
        );
        return res;
      } catch {
        return undefined;
      }
    },
    "dialog.saveText": async (p) => {
      const content = str(p, "content");
      const suggested = optStr(p, "suggestedName") ?? "export.json";
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(suggested),
      });
      if (!uri) return { saved: false };
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      return { saved: true, path: uri.fsPath };
    },
    "dialog.openText": async (p) => {
      const filters = (p.filters as Record<string, string[]> | undefined) ?? {
        "Session export": ["json"],
      };
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters,
      });
      if (!uris || uris.length === 0) return undefined;
      const doc = await vscode.workspace.openTextDocument(uris[0]!);
      return doc.getText();
    },
    "settings.update": (p) => {
      const updates = p.updates as
        Array<{ key?: unknown; value?: unknown }> | undefined;
      if (!Array.isArray(updates))
        throw new Error("rpc: 'updates' must be an array");
      const cfg = vscode.workspace.getConfiguration("opencode2");
      for (const u of updates) {
        const key = typeof u?.key === "string" ? u.key : "";
        if (!isSettingKey(key))
          throw new Error(`rpc: unsupported setting '${key}'`);
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
      if (!config || typeof config !== "object")
        throw new Error("rpc: missing 'config'");
      return api.mcpAdd(name, config);
    },
    "mcp.remove": (p) => api.mcpRemove(str(p, "name")),
    "mcp.resources": () => api.mcpResources(),
    "mcp.connect": (p) => api.mcpConnect(str(p, "name")),
    "mcp.disconnect": (p) => api.mcpDisconnect(str(p, "name")),
    "mcp.codemode": async (p) => {
      // Read the server's effective mcp config and re-add it with a toggled
      // codemode flag (V2 has no partial-update endpoint; mcp.add replaces
      // the named server's runtime config). Default is true per V2 docs.
      const name = str(p, "name");
      const cfg = await api.configGet();
      const servers =
        ((cfg.mcp as { servers?: Record<string, unknown> } | undefined)
          ?.servers as Record<string, unknown> | undefined) ?? {};
      if (p.get === true) {
        // Read-only mode: report current codemode for every server.
        const out: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(servers)) {
          const cm = (value as { codemode?: unknown }).codemode;
          out[key] = cm === false ? false : true;
        }
        return out;
      }
      const existing = servers[name];
      if (typeof existing !== "object" || existing === null) {
        throw new Error(`Unknown MCP server: ${name}`);
      }
      await api.mcpAdd(name, {
        ...(existing as Record<string, unknown>),
        codemode: p.enabled !== false,
      });
      return true;
    },
    "providers.authCli": async (p) => {
      // Use the actually-resolved binary (opencode2 on this machine, opencode
      // for npm-only installs) instead of a hard-coded name.
      const resolved = resolveCli ? await resolveCli() : undefined;
      const bin = resolved
        ? (resolved.program
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.exe$/i, "") ?? "opencode2")
        : "opencode2";
      const name = optStr(p, "name");
      // Never interpolate the webview-supplied provider name into shell text:
      // it can carry spaces/quotes/metacharacters (`a; rm -rf ~`). Validate
      // against the safe CLI-arg alphabet and pass via argv array instead.
      if (name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
        throw new Error("rpc: invalid provider name");
      const terminal = vscode.window.createTerminal({
        name: "OpenCode 2 — connect provider",
      });
      terminal.show();
      // sendText takes a raw string (no argv form) — with the name validated
      // above, interpolation is safe; unvalidated input never reaches here.
      terminal.sendText(`${bin} auth login${name ? ` ${name}` : ""}`, true);
      log.info(
        `provider auth handoff: ${bin} auth login${name ? ` ${name}` : ""}`,
      );
      return true;
    },
    "settings.open": async (p) => {
      const query = typeof p.query === "string" && p.query.length > 0 ? p.query : "opencode2";
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        query,
      );
      return true;
    },
    "url.open": async (p) => {
      const raw = str(p, "url");
      // The webview is a trust boundary: only http(s) leaves the machine.
      // Anything else (file:, vscode:, command:, data:, javascript:) is refused.
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error("rpc: invalid url");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error(`rpc: refusing to open non-http(s) url`);
      const uri = vscode.Uri.parse(raw, true);
      await vscode.env.openExternal(uri);
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
      if (
        /^[a-zA-Z]:[\\/]/.test(filePart) ||
        filePart.startsWith("/") ||
        filePart.startsWith("\\")
      ) {
        uri = vscode.Uri.file(filePart);
      } else {
        const base =
          preferredDirectory() ??
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!base) throw new Error(`Cannot resolve relative path: ${raw}`);
        const joined = path.join(base, filePart);
        uri = vscode.Uri.file(joined);
      }
      // try to open, reveal line
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
      });
      if (line !== undefined) {
        const pos = new vscode.Position(
          Math.max(0, line - 1),
          Math.max(0, (col ?? 1) - 1),
        );
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter,
        );
      }
      return true;
    },
    "diff.previewPreApply": (p) => {
      // Native side-by-side preview of a proposed (not-yet-applied) change.
      const file = str(p, "file");
      const patch = str(p, "patch");
      const status = optStr(p, "status");
      const additions =
        typeof p.additions === "number" ? p.additions : undefined;
      const deletions =
        typeof p.deletions === "number" ? p.deletions : undefined;
      return diffPreview.preview({
        file,
        patch,
        additions,
        deletions,
        status,
      } satisfies WireFileDiff);
    },
    "diff.open": async (p) => {
      const file = str(p, "file");
      const diff = optStr(p, "diff") ?? "";
      if (diff) {
        // Read-only provider doc — no save prompt on close (unlike untitled)
        return workingDiffDocs.show(diff, `OpenCode Diff: ${file}`);
      }
      // No diff string: open whole-file diff via VS Code's git provider (shows full file)
      const base =
        preferredDirectory() ??
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let fileUri: vscode.Uri;
      if (
        /^[a-zA-Z]:[\\/]/.test(file) ||
        file.startsWith("/") ||
        file.startsWith("\\")
      )
        fileUri = vscode.Uri.file(file);
      else if (base) fileUri = vscode.Uri.file(path.join(base, file));
      else throw new Error("no base");
      try {
        const gitUri = fileUri.with({
          scheme: "git",
          query: JSON.stringify({ path: fileUri.fsPath, ref: "HEAD" }),
        });
        await vscode.commands.executeCommand(
          "vscode.diff",
          gitUri,
          fileUri,
          `${path.basename(fileUri.fsPath)} ↔ Working Tree`,
        );
        return true;
      } catch {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        return true;
      }
    },
    "image.save": async (p) => {
      const data = str(p, "data");
      // Bound the decode: base64 inflates ~4/3, so 15M chars ≈ 11MB — the
      // webview must never OOM the extension host with one paste.
      if (data.length > 15_000_000)
        throw new Error("rpc: image too large (max ~11MB)");
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
    "companion.status": async () => {
      const cfg = readListenConfig();
      return { config: cfg, url: companion?.url, running: companion?.isRunning ?? false };
    },
    "companion.update": async (p) => {
      const cfg = vscode.workspace.getConfiguration("opencode2");
      // Validate & coerce EVERY field before writing any — a late failure
      // must not leave settings half-updated while the running server kept
      // the previous bind config.
      const writes: Array<[string, unknown]> = [];
      if (p.enabled !== undefined) {
        if (typeof p.enabled !== "boolean") throw new Error("enabled must be boolean");
        writes.push(["server.listenEnabled", p.enabled]);
      }
      if (p.hostname !== undefined) {
        if (typeof p.hostname !== "string" || !p.hostname.trim()) throw new Error("hostname must be non-empty string");
        writes.push(["server.listenHostname", p.hostname.trim()]);
      }
      if (p.port !== undefined) {
        const n = typeof p.port === "number" ? p.port : Number(p.port);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("port must be 1-65535");
        writes.push(["server.listenPort", n]);
      }
      if (p.username !== undefined) {
        if (typeof p.username !== "string") throw new Error("username must be string");
        writes.push(["server.listenUsername", p.username]);
      }
      if (p.password !== undefined) {
        if (typeof p.password !== "string") throw new Error("password must be string");
        writes.push(["server.listenPassword", p.password]);
      }
      if (p.cors !== undefined) {
        if (!Array.isArray(p.cors) || !p.cors.every((x) => typeof x === "string")) throw new Error("cors must be string[]");
        writes.push(["server.listenCors", p.cors]);
      }
      const tryUpdate = async (key: string, value: unknown): Promise<void> => {
        try {
          await cfg.update(key, value, vscode.ConfigurationTarget.Global);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("not a registered configuration")) {
            throw new Error(`${msg} — please reload VS Code window (Ctrl+R / Developer: Reload Window) after installing 0.6.42, then try again.`);
          }
          throw e;
        }
      };
      for (const [key, value] of writes) await tryUpdate(key, value);
      // trigger restart is handled by onDidChangeConfiguration, but ensure immediate sync if provided
      if (companion) await companion.start();
      const updated = readListenConfig();
      return { config: updated, url: companion?.url, running: companion?.isRunning ?? false };
    },
    "companion.restart": async () => {
      if (!companion) throw new Error("companion server not available");
      await companion.start();
      const cfg = readListenConfig();
      return { config: cfg, url: companion.url, running: companion.isRunning };
    },
  };

  /** Handle one request; never throws — failures become RpcResponse errors. */
  async function handle(
    request: RpcRequest,
  ): Promise<{ id: number; ok: boolean; result?: unknown; error?: string }> {
    const handler = handlers[request.method] as Handler | undefined;
    if (!handler) {
      return {
        id: request.id,
        ok: false,
        error: `Unknown rpc method: ${String(request.method)}`,
      };
    }
    try {
      const result = await handler(request.params ?? {});
      return { id: request.id, ok: true, result };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : (() => {
                try {
                  const s = JSON.stringify(error);
                  return s && s !== "{}" ? s.slice(0, 2000) : String(error);
                } catch {
                  return String(error);
                }
              })();
      log.error(`rpc ${request.method} failed`, error);
      return { id: request.id, ok: false, error: message };
    }
  }

  return {
    handle,
    getActiveSessionId,
    /** Last session the user had open (persisted in workspaceState). */
    getLastSession: (): string | undefined =>
      storage?.get<string>("lastSession"),
    /** Disposable for diff document providers. */
    previews: {
      dispose: () => {
        diffPreview.dispose();
        workingDiffDocs.dispose();
      },
    } as unknown as vscode.Disposable,
  };
}

/**
 * Win32 drive-letter canonicalization. VERIFIED LIVE 2026-08-26: the V2
 * server's instruction initializer crashes ("Maximum call stack size
 * exceeded" → Instructions.InitializationBlocked) when a session's location
 * carries a lowercase drive letter — every prompt then silently fails to
 * persist. Uppercasing the drive avoids the poisoned state entirely.
 */
export { canonicalizeDirectory } from "./directory";

/** Multi-root: prefer the workspace folder of the focused editor, else first. */
export function preferredDirectory(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  let candidate: string | undefined;
  if (editor) {
    candidate = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri
      .fsPath;
  }
  if (!candidate) {
    const fallback =
      vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file") ??
      vscode.workspace.workspaceFolders?.[0];
    candidate = fallback?.uri.fsPath;
  }
  return candidate ? canonicalizeDirectory(candidate) : undefined;
}

export type RpcDispatcher = ReturnType<typeof createRpcDispatcher>;
