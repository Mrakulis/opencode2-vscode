import * as vscode from "vscode";

/** Output-channel logger; verbose lines are gated behind `opencode2.debug.logs`. */
export class Log {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name = "OpenCode 2") {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  get debugEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("opencode2")
      .get<boolean>("debug.logs", false);
  }

  info(message: string): void {
    this.channel.info(message);
  }

  /** Only surfaced when `opencode2.debug.logs` is enabled. */
  debug(message: string, error?: unknown): void {
    if (!this.debugEnabled) return;
    const detail =
      error instanceof Error
        ? error.message
        : error === undefined
          ? ""
          : String(error);
    this.channel.debug(detail ? `${message} — ${detail}` : message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, error?: unknown): void {
    const detail =
      error instanceof Error
        ? error.message
        : error === undefined
          ? ""
          : String(error);
    this.channel.error(detail ? `${message} — ${detail}` : message);
  }

  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
