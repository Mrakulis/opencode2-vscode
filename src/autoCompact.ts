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
  private readonly inflight = new Set<string>();
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
    // Burst guard: session.usage.updated can fire several times per run —
    // without this, duplicate compacts race before armed=false lands.
    if (this.inflight.has(sessionID)) return;
    this.inflight.add(sessionID);

    try {
      const client = this.controller.getClient();
      const session = await client.session.get({ sessionID });
      // Beta drift: session.model may be undefined OR a bare string on some
      // builds — only object refs with string fields are usable here.
      const modelRef = session.model as unknown;
      if (
        !modelRef ||
        typeof modelRef !== "object" ||
        typeof (modelRef as { providerID?: unknown }).providerID !==
          "string" ||
        typeof (modelRef as { id?: unknown }).id !== "string"
      )
        return;
      const { providerID, id } = modelRef as {
        providerID: string;
        id: string;
      };
      const limit = this.contextLimits.get(`${providerID}/${id}`);
      if (!limit) return;

      // Session-level tokens are CUMULATIVE lifetime usage and survive
      // compaction — useless for threshold math. Use the newest assistant
      // step snapshot after the last compaction checkpoint instead.
      const usage = await this.latestStepUsage(sessionID);
      if (!usage) return; // nothing post-compaction yet — don't guess
      const total =
        usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write;
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
    } finally {
      this.inflight.delete(sessionID);
    }
  }

  /**
   * Host-side mirror of the webview's liveContextStepTokens(): the newest
   * assistant-step token snapshot created AFTER the newest synthetic
   * compaction marker, or undefined when there isn't one.
   */
  private async latestStepUsage(
    sessionID: string,
  ): Promise<
    | { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    | undefined
  > {
    const client = this.controller.getClient();
    const res = await client.message.list({ sessionID });
    const rows = (Array.isArray(res) ? res : res.data ?? []) as Array<{
      type?: string;
      time?: { created?: number };
      tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      };
    }>;
    let cutoff = 0;
    for (const m of rows) {
      if (m.type === "synthetic") {
        cutoff = Math.max(cutoff, m.time?.created ?? 0);
      }
    }
    let best;
    let bestAt = -1;
    for (const m of rows) {
      const at = m.time?.created ?? 0;
      if (
        m.type !== "assistant" ||
        !m.tokens ||
        !(m.tokens.input > 0) ||
        at <= cutoff ||
        at < bestAt
      )
        continue;
      bestAt = at;
      best = m.tokens;
    }
    return best;
  }

  private refreshLimits(): void {
    try {
      const client = this.controller.getClient();
      // Go through the adapter's normalized `models()` so list-shape drift
      // (bare array vs `{data}`) can't break limit caching — reading `res.data`
      // directly silently returned nothing and disabled auto-compaction.
      void createApi({ getClient: () => client })
        .models()
        .then((models) => this.setContextLimits(models))
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
