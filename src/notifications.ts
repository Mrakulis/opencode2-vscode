import * as vscode from "vscode";
import type { OpenCodeController } from "./controller";

/**
 * Desktop notifications for agent lifecycle events, routed around the session
 * the user is currently viewing in the sidebar (that one gets no toast — the
 * webview already shows it live).
 */
export class NotificationService implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;

  constructor(
    controller: OpenCodeController,
    private readonly getActiveSessionId: () => string | undefined,
  ) {
    this.subscription = controller.onEvent((event) => {
      const sid = (event.data as { sessionID?: string } | undefined)?.sessionID;
      if (!sid || sid === this.getActiveSessionId()) return;

      const cfg = vscode.workspace.getConfiguration("opencode2");

      if (
        event.type === "session.execution.succeeded" &&
        cfg.get<boolean>("notifications.agentEvents", true)
      ) {
        void vscode.window
          .showInformationMessage("OpenCode 2: agent finished.", "Show")
          .then((pick) => {
            if (pick === "Show")
              void vscode.commands.executeCommand("opencode2.focus");
          });
      }

      if (
        event.type === "session.execution.failed" &&
        cfg.get<boolean>("notifications.errors", false)
      ) {
        void vscode.window
          .showErrorMessage("OpenCode 2: agent run failed.", "Show")
          .then((pick) => {
            if (pick === "Show")
              void vscode.commands.executeCommand("opencode2.focus");
          });
      }

      if (
        event.type === "permission.asked" &&
        cfg.get<boolean>("notifications.permissions", true)
      ) {
        const action =
          (event.data as { action?: string } | undefined)?.action ?? "action";
        void vscode.window
          .showWarningMessage(
            `OpenCode 2: permission requested — ${action}.`,
            "Review",
          )
          .then((pick) => {
            if (pick === "Review")
              void vscode.commands.executeCommand("opencode2.focus");
          });
      }
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
