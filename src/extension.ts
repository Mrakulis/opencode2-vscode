import * as vscode from "vscode";
import { installCli, resolveCli } from "./cli";
import { AutoCompactWatcher } from "./autoCompact";
import { OpenCodeController } from "./controller";
import { Log } from "./log";
import { NotificationService } from "./notifications";
import { createRpcDispatcher } from "./rpc";
import { SidebarProvider, SIDEBAR_VIEW_ID } from "./sidebarProvider";

export function activate(context: vscode.ExtensionContext): void {
  const log = new Log();
  const controller = new OpenCodeController(log, () => resolveCli(log));
  const rpc = createRpcDispatcher(controller, log);
  const provider = new SidebarProvider(context.extensionUri, controller, rpc);
  const autoCompact = new AutoCompactWatcher(controller, log);
  const notifications = new NotificationService(controller, log, rpc.getActiveSessionId);

  // Status bar mirrors the original UX: connected / connecting / error.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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
          statusBar.tooltip = "OpenCode connection error — click for output";
          statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
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

  context.subscriptions.push(
    log,
    controller,
    autoCompact,
    notifications,
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
    vscode.commands.registerCommand("opencode2.toggle", () => provider.toggle()),
    vscode.commands.registerCommand("opencode2.refresh", () => {
      connect();
      return provider.reveal();
    }),
    vscode.commands.registerCommand("opencode2.restartService", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "OpenCode 2: restarting service..." },
        () => controller.restart(),
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
    vscode.commands.registerCommand("opencode2.installCli", () => installCli(log)),
    vscode.commands.registerCommand("opencode2.newSession", async () => {
      await provider.reveal();
      await provider.createAndSelectSession();
    }),
    vscode.commands.registerCommand("opencode2.showTestQuestion", async () => {
      await provider.reveal();
      provider.showQuestion(
        "What should we tackle next?",
        ["Polish question picker to match Desktop pixel-perfect", "Add test harness for permissions/questions", "Other"],
        "Polish question picker to match Desktop pixel-perfect",
        true,
      );
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("opencode2")) return;
      if (
        event.affectsConfiguration("opencode2.server") ||
        event.affectsConfiguration("opencode2.cliPath")
      ) {
        connect();
      }
    }),
  );

  connect();
}

export function deactivate(): void {
  // Disposables are registered via context.subscriptions; the shared
  // background service intentionally outlives the window.
}
