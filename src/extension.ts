import * as vscode from "vscode";
import { installCli, resolveCli } from "./cli";
import { AutoCompactWatcher } from "./autoCompact";
import { AutoTitleWatcher } from "./autoTitle";
import { OpenCodeController } from "./controller";
import { ExtensionServer } from "./extensionServer";
import { Log } from "./log";
import { NotificationService } from "./notifications";
import { createRpcDispatcher } from "./rpc";
import { SidebarProvider, SIDEBAR_VIEW_ID } from "./sidebarProvider";

export function activate(context: vscode.ExtensionContext): void {
  const log = new Log();
  const controller = new OpenCodeController(log, () => resolveCli(log));
  const extensionServer = new ExtensionServer(log, () => controller.restart({ force: true }));
  const rpc = createRpcDispatcher(
    controller,
    log,
    () => resolveCli(log),
    context.workspaceState,
    extensionServer,
  );
  const provider = new SidebarProvider(context.extensionUri, controller, rpc);
  const autoCompact = new AutoCompactWatcher(controller, log);
  const autoTitle = new AutoTitleWatcher(controller, log);
  const notifications = new NotificationService(
    controller,
    rpc.getActiveSessionId,
    (sid) => provider.focusSession(sid),
  );

  // Status bar mirrors the original UX: connected / connecting / error.
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "opencode2.focus";
  context.subscriptions.push(
    statusBar,
    controller.onDidChangeState((state) => {
      switch (state) {
        case "connected": {
          statusBar.text = "$(check) OpenCode";
          statusBar.tooltip = `Connected to ${controller.baseUrl ?? "OpenCode service"}`;
          statusBar.backgroundColor = undefined;
          break;
        }
        case "connecting": {
          statusBar.text = "$(sync~spin) OpenCode";
          statusBar.tooltip = "Connecting to OpenCode service...";
          statusBar.backgroundColor = undefined;
          break;
        }
        case "error": {
          statusBar.text = "$(warning) OpenCode";
          statusBar.tooltip =
            "OpenCode connection error — click to open the sidebar";
          statusBar.backgroundColor = new vscode.ThemeColor(
            "statusBarItem.warningBackground",
          );
          break;
        }
      }
      statusBar.show();
    }),
  );

  const connect = (): void => {
    void controller.connect().catch(() => {
      /* error state already broadcast; details in output channel */
    });
  };

  const syncExtensionServer = (): void => {
    void extensionServer.start().catch((err) => {
      log.error("extension server sync failed", err);
    });
  };

  context.subscriptions.push(
    log,
    controller,
    extensionServer,
    autoCompact,
    autoTitle,
    notifications,
    rpc.previews,
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => {
        // Session scope follows the opened folder(s); resync re-applies it.
        provider.notifyResync();
      },
      null,
      context.subscriptions,
    ),
    vscode.commands.registerCommand("opencode2.focus", () => provider.reveal()),
    vscode.commands.registerCommand("opencode2.toggle", () =>
      provider.toggle(),
    ),
    vscode.commands.registerCommand("opencode2.refresh", () => {
      connect();
      return provider.reveal();
    }),
    vscode.commands.registerCommand("opencode2.restartService", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "OpenCode 2: restarting service...",
        },
        () => controller.restart({ force: true }),
      );
    }),
    vscode.commands.registerCommand("opencode2.openTerminal", async () => {
      const cli = await resolveCli(log);
      const folder = vscode.workspace.workspaceFolders?.[0];
      const terminal = vscode.window.createTerminal({
        name: "OpenCode",
        cwd: folder?.uri.fsPath,
      });
      terminal.show();
      terminal.sendText(cli?.display ?? "opencode2", true);
    }),
    vscode.commands.registerCommand("opencode2.installCli", () =>
      installCli(log),
    ),
    vscode.commands.registerCommand("opencode2.newSession", async () => {
      await provider.reveal();
      await provider.createAndSelectSession();
    }),
    vscode.commands.registerCommand("opencode2.showExtensionServerUrl", async () => {
      const url = extensionServer.url;
      if (!url) {
        const cfg = vscode.workspace.getConfiguration("opencode2");
        const enabled = cfg.get<boolean>("server.listenEnabled", false);
        if (!enabled) {
          void vscode.window.showInformationMessage("Extension server is disabled — enable opencode2.server.listenEnabled first.");
        } else {
          void vscode.window.showWarningMessage("Extension server is not running — check Output channel for errors.");
        }
        return;
      }
      await vscode.env.clipboard.writeText(url);
      void vscode.window.showInformationMessage(`Copied: ${url}`);
    }),
    vscode.commands.registerCommand("opencode2.restartExtensionServer", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "OpenCode 2: restarting extension server..." },
        () => extensionServer.start(),
      );
    }),
    vscode.commands.registerCommand("opencode2.companionServer", async () => {
      // Top-menu entry: open the screen where IP/port + password are set.
      // Placeholder for future app link — settings screen is the source of truth.
      await vscode.commands.executeCommand("workbench.action.openSettings", "opencode2.server.listen");
      const url = extensionServer.url;
      if (url) {
        const copy = "Copy URL";
        const choice = await vscode.window.showInformationMessage(`Companion server at ${url} — configure IP/port above.`, copy);
        if (choice === copy) await vscode.env.clipboard.writeText(url);
      } else {
        void vscode.window.showInformationMessage("Set IP/port above, then enable opencode2.server.listenEnabled. App link coming soon.");
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("opencode2")) return;
      // server.listen* is the extension-owned companion server. Match its real
      // keys explicitly — a prefix needle like "opencode2.server.listen" never
      // matches (VS Code aligns sections at key-segment boundaries and the
      // actual keys are server.listenEnabled etc.), which made both branches
      // shipped in 0.6.44 dead: listen changes reconnected the daemon and
      // Settings-UI toggles never started the server.
      const affectsListen = [
        "listenEnabled",
        "listenHostname",
        "listenPort",
        "listenUsername",
        "listenPassword",
        "listenCors",
      ].some((k) => event.affectsConfiguration(`opencode2.server.${k}`));
      // Companion settings must not reconnect the daemon — only the listen
      // server itself resyncs.
      if (
        (event.affectsConfiguration("opencode2.server") && !affectsListen) ||
        event.affectsConfiguration("opencode2.cliPath")
      ) {
        connect();
      }
      if (affectsListen) {
        syncExtensionServer();
      }
    }),
  );

  connect();
  syncExtensionServer();
}

export function deactivate(): void {
  // Disposables are registered via context.subscriptions; the shared
  // background service intentionally outlives the window.
}
