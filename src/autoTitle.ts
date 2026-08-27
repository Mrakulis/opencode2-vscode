import * as vscode from "vscode";
import { createApi } from "./apiAdapter";
import type { OpenCodeController } from "./controller";
import { Log } from "./log";

/** Titles considered "unset" — replaced by auto-title on the first completed turn. */
const DEFAULT_TITLES = new Set([
  "",
  "new session",
  "untitled",
  "untitled session",
]);

/** Short, terse instruction; the model replies with a bare title (no history). */
const TITLE_PROMPT =
  "Give this conversation a short, descriptive title (3–6 words, no quotes, no emoji). Reply with only the title.";

const MAX_TITLE_LEN = 80;

/**
 * Auto-title watcher (#3 from the Phase A plan): once a session finishes its
 * first completed turn, fire `session.generate` (transient, history-non-mutating)
 * and `session.rename` with the produced title — unless the user already named
 * it. Opt-in via `opencode2.sessions.autoTitle` (default off) because generate
 * spends real provider tokens.
 *
 * Mirrors the AutoCompactWatcher host-side pattern: subscribes to controller
 * events, does its client work through the api adapter, never touches the webview.
 */
export class AutoTitleWatcher implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private readonly inflight = new Set<string>();

  constructor(
    private readonly controller: OpenCodeController,
    private readonly log: Log,
  ) {
    this.subscription = controller.onEvent((event) => {
      if (event.type === "session.execution.succeeded") {
        const sid = event.data?.sessionID;
        if (sid) void this.maybeTitle(sid);
      }
    });
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration("opencode2")
      .get<boolean>("sessions.autoTitle", false);
  }

  private async maybeTitle(sessionID: string): Promise<void> {
    if (!this.enabled() || this.inflight.has(sessionID)) return;
    this.inflight.add(sessionID);
    try {
      const api = createApi({ getClient: () => this.controller.getClient() });
      let session = await api.sessionGet(sessionID);
      if (!this.isDefaultTitle(session.title)) return;

      const generated =
        (await api.sessionGenerate(sessionID, TITLE_PROMPT)) ?? "";
      const title = generated.trim().replace(/^"|"$/g, "");
      if (!title || title.length > MAX_TITLE_LEN) return;

      // Race guard: the user (or another client) may have renamed while we
      // generated — never clobber a deliberate title.
      session = await api.sessionGet(sessionID);
      if (!this.isDefaultTitle(session.title)) return;

      await api.sessionRename(sessionID, title);
      this.log.info(`auto-titled ${sessionID}: ${title}`);
    } catch (error) {
      // generate/rename are best-effort; a flaky call must never surface or block.
      this.log.debug("auto-title skipped", error);
    } finally {
      this.inflight.delete(sessionID);
    }
  }

  private isDefaultTitle(title: string | undefined): boolean {
    if (!title) return true;
    return DEFAULT_TITLES.has(title.trim().toLowerCase());
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
