import * as vscode from "vscode";
import { createApi } from "./apiAdapter";
import type { OpenCodeController } from "./controller";
import { Log } from "./log";

/**
 * Auto-compact watcher (#10 from upstream): when a session's token usage
 * crosses `opencode2.agent.autoCompactThreshold` percent of the active
 * model's context window, fire `session.compact` once per run.
 *
 * The "armed" flag resets when a new execution starts, so long-running
 * sessions compact at most one extra time per user turn.
 */
export class AutoCompactWatcher implements vscode.Disposable {
  private readonly armed = new Map<string, boolean>();
  private readonly contextLimits = new Map<string, number>(); // `${providerID}/${id}` -> tokens
  private readonly subscription: vscode.Disposable;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly controller: OpenCodeController,
    private readonly log: Log,
  ) {
    this.subscription = controller.onEvent((event) => {
      switch (event.type) {
        case "session.usage.updated": {
          void this.check(event.data?.sessionID);
          break;
        }
        case "session.execution.started": {
          const sid = event.data?.sessionID;
          if (sid) this.armed.set(sid, true);
          break;
        }
      }
    });
    // Refresh known context limits occasionally.
    this.refreshLimits();
    const timer = setInterval(() => this.refreshLimits(), 5 * 60_000);
    this.disposables.push({ dispose: () => clearInterval(timer) });
  }

  setContextLimits(
    models: Array<{
      providerID: string;
      modelID?: string;
      id?: string;
      limit?: { context?: number };
    }>,
  ): void {
    for (const m of models) {
      const key = `${m.providerID}/${m.modelID ?? m.id ?? ""}`;
      if (m.limit?.context && m.limit.context > 0)
        this.contextLimits.set(key, m.limit.context);
    }
  }

  private async check(sessionID: string | undefined): Promise<void> {
    if (!sessionID) return;
    const threshold = this.threshold();
    if (!threshold) return; // disabled (0)

    try {
      const client = this.controller.getClient();
      const session = await client.session.get({ sessionID });
      const modelRef = session.model;
      if (!modelRef) return;
      const limit = this.contextLimits.get(
        `${modelRef.providerID}/${modelRef.id}`,
      );
      if (!limit) return;

      const t = session.tokens;
      const total =
        t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
      const pct = (total / limit) * 100;
      if (pct < threshold) return;

      if (this.armed.get(sessionID) === false) return; // already compacted this run
      this.log.info(
        `auto-compacting ${sessionID}: ${Math.round(pct)}% of ${limit} tokens (threshold ${threshold}%)`,
      );
      this.armed.set(sessionID, false);
      await createApi({ getClient: () => this.controller.getClient() }).compact(
        sessionID,
      );
    } catch (error) {
      this.log.debug("auto-compact check skipped", error);
    }
  }

  private refreshLimits(): void {
    try {
      const client = this.controller.getClient();
      void client.model
        .list()
        .then((res) => this.setContextLimits(res.data as never))
        .catch(() => undefined);
    } catch {
      /* not connected */
    }
  }

  private threshold(): number {
    return vscode.workspace
      .getConfiguration("opencode2")
      .get<number>("agent.autoCompactThreshold", 0);
  }

  dispose(): void {
    this.subscription.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
