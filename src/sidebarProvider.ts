import * as vscode from "vscode";
import { createApi } from "./apiAdapter";
import type { OpenCodeController } from "./controller";
import {
  isInbound,
  type InboundMessage,
  type OutboundMessage,
  type RpcResponse,
  type WireForm,
  type WireFormField,
} from "./protocol";
import type { RpcDispatcher } from "./rpc";
import { preferredDirectory } from "./rpc";

export const SIDEBAR_VIEW_ID = "opencode2.sidebar";

/**
 * Normalize a V2 FormInfo-ish object into our dependency-free WireForm.
 * Unknown field kinds are passed through with their key/title so the UI can
 * at least render a text input for them.
 */
export function toWireForm(raw: unknown): WireForm | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id : "";
  const sessionID = typeof rec.sessionID === "string" ? rec.sessionID : "";
  const title = typeof rec.title === "string" ? rec.title : "Agent input";
  const fieldsRaw = Array.isArray(rec.fields) ? rec.fields : [];
  const fields: WireFormField[] = [];
  for (const f of fieldsRaw) {
    if (typeof f !== "object" || f === null) continue;
    const fr = f as Record<string, unknown>;
    const key = typeof fr.key === "string" ? fr.key : "";
    if (!key) continue;
    const options = Array.isArray(fr.options)
      ? fr.options
          .filter(
            (o): o is Record<string, unknown> =>
              typeof o === "object" && o !== null,
          )
          .map((o) => ({
            label:
              typeof o.label === "string" ? o.label : String(o.value ?? ""),
            value: o.value as string | number | boolean | undefined,
          }))
      : undefined;
    fields.push({
      key,
      title: typeof fr.title === "string" ? fr.title : key,
      description:
        typeof fr.description === "string" ? fr.description : undefined,
      required: fr.required === true,
      type: typeof fr.type === "string" ? fr.type : "string",
      options,
      default:
        typeof fr.default === "string" ||
        typeof fr.default === "number" ||
        typeof fr.default === "boolean"
          ? fr.default
          : undefined,
      placeholder:
        typeof fr.placeholder === "string" ? fr.placeholder : undefined,
    });
  }
  return { id, sessionID, title, fields };
}

/**
 * Hosts the React chat UI. All server I/O happens in the extension host;
 * this class is the webview boundary: config pushes, connection state,
 * raw V2 events, resync notices, and RPC request/result routing.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: OpenCodeController,
    private readonly rpc: RpcDispatcher,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    const pushState = (): void => this.pushState();

    // Immediate push + delayed safety net — the webview JS may not have
    // registered its message listener yet when resolveWebviewView runs,
    // especially during auto-start where connect() resolves asynchronously.
    pushState();
        const repush1 = setTimeout(pushState, 1000);
    const repush2 = setTimeout(pushState, 3000);
    this.disposables.push({
      dispose: () => {
        clearTimeout(repush1);
        clearTimeout(repush2);
      },
    });

    view.onDidDispose(
      () => {
        this.view = undefined;
        for (const d of this.disposables.splice(0)) d.dispose();
      },
      null,
      this.disposables,
    );

    view.webview.onDidReceiveMessage(
      (raw: unknown) => {
        if (!isInbound(raw)) return;
        void this.handle(raw as unknown as OutboundMessage, pushState);
      },
      null,
      this.disposables,
    );

    // Re-push resolved config so the UI never holds a stale copy.
    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration("opencode2")) pushState();
      },
      null,
      this.disposables,
    );

    this.controller.onDidChangeState(
      (state) =>
        this.post({
          type: "connection",
          state,
          detail:
            state === "error" ? this.controller.lastErrorDetail : undefined,
          lastSession: this.rpc.getLastSession(),
        } satisfies InboundMessage),
      null,
      this.disposables,
    );
    this.controller.onEvent(
      (event) => {
        this.post({ type: "event", event } satisfies InboundMessage);
        // Real form requests replace the old text-heuristic "question" flow.
        if ((event as { type?: string }).type === "form.created") {
          const wire = toWireForm((event as { data?: unknown }).data);
          if (wire)
            this.post({ type: "form", form: wire } satisfies InboundMessage);
        }
      },
      null,
      this.disposables,
    );
    this.controller.onResync(
      () => this.post({ type: "resync" }),
      null,
      this.disposables,
    );

    // Re-sync state whenever the panel becomes visible — covers the case where
    // a connection resolved while the view was still hidden/not yet mounted.
    view.onDidChangeVisibility(
      () => {
        if (view.visible) pushState();
      },
      null,
      this.disposables,
    );

    view.webview.html = this.renderHtml(view.webview);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${SIDEBAR_VIEW_ID}.focus`);
  }

  async toggle(): Promise<void> {
    if (this.view?.visible) {
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
    } else {
      await this.reveal();
    }
  }

  /** Ask the webview to refetch everything (workspace scope changed). */
  notifyResync(): void {
    this.post({ type: "resync" });
  }

  /**
   * Focus the sidebar and (optionally) select a session — used by the
   * permission notification "Review" action so the asking session and its
   * permission card actually surface.
   */
  focusSession(sessionID?: string): void {
    void this.reveal();
    if (sessionID) this.post({ type: "selectSession", id: sessionID });
  }

  /** Create a session in the active workspace and tell the UI to select it. */
  async createAndSelectSession(): Promise<void> {
    try {
      const api = createApi({ getClient: () => this.controller.getClient() });
      const directory = preferredDirectory();
      const session = await api.sessionCreate({ directory });
      this.post({
        type: "selectSession",
        id: session.id,
      } satisfies InboundMessage);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `OpenCode 2: could not create session — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handle(
    message: OutboundMessage,
    pushState: () => void,
  ): Promise<void> {
    switch (message.type) {
      case "hello": {
        pushState();
        break;
      }
      case "rpc": {
        const { id, ok, result, error } = await this.rpc.handle(message);
        this.post({ type: "rpcResult", id, ok, result, error });
        break;
      }
    }
  }

  private post(message: InboundMessage | RpcResponse): void {
    void this.view?.webview.postMessage(message);
  }

  /** Push the resolved config (ready) plus live connection state to the UI. */
  private pushState(): void {
    this.post({
      type: "ready",
      config: this.getConfig(),
    });
    // Always include live connection state — it may have changed while the
    // webview was still loading.
    this.post({
      type: "connection",
      state: this.controller.state,
      lastSession: this.rpc.getLastSession(),
    } satisfies InboundMessage);
  }

  private getConfig(): import("./protocol").ResolvedConfig {
    const cfg = vscode.workspace.getConfiguration("opencode2");
    return {
      ui: {
        density: cfg.get<"compact" | "comfortable">("ui.density", "compact"),
        theme: cfg.get<
          "dark" | "light" | "tokyonight" | "gruvbox" | "nord" | "catppuccin"
        >("ui.theme", "dark"),
        accentTint: cfg.get<string>("ui.accentTint") || undefined,
        sounds: cfg.get<boolean>("ui.sounds", true),
        showReasoning: cfg.get<"hide" | "collapsed" | "expanded">(
          "ui.showReasoning",
          "collapsed",
        ),
        expandShellTools: cfg.get<boolean>("ui.expandShellTools", false),
        expandEditTools: cfg.get<boolean>("ui.expandEditTools", false),
        fullShellOutput: cfg.get<boolean>("ui.fullShellOutput", false),
        messageStats: cfg.get<boolean>("ui.messageStats", true),
        sendKey: cfg.get<"enter" | "ctrlEnter">("composer.sendKey", "enter"),
      },
      models: {
        hidden: cfg.get<string[]>("models.hidden", []),
        favorites: cfg.get<string[]>("models.favorites", []),
        default: cfg.get<string>("models.default", "opencode/big-pickle"),
      },
      permissions: {
        mode: cfg.get<"askFirst" | "autoAllow" | "deny">(
          "permissions.mode",
          "askFirst",
        ),
      },
      agent: {
        autoCompactThreshold: cfg.get<number>("agent.autoCompactThreshold", 0),
      },
    };
  }

  private renderHtml(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "main.js"),
    );
    const styles = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "main.css"),
    );
    const nonce = getNonce();
    const initialConfig = JSON.stringify(this.getConfig()).replace(
      /</g,
      "\\u003c",
    );

    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:;" />
<link rel="stylesheet" href="${styles}" />
<title>OpenCode 2</title>
</head>
<body>
<div id="root"></div>
<script id="oc2-initial-config" type="application/json">${initialConfig}</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let out = "";
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// Node 18+ exposes web crypto; guard for odd runtimes anyway.
declare const crypto: { getRandomValues(array: Uint8Array): Uint8Array };
