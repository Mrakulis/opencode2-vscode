import {
  OpenCode,
  type OpenCodeClient,
  type OpenCodeEvent,
} from "@opencode-ai/client";
import { Service, type Endpoint } from "@opencode-ai/client/service";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { spawnArgvHost, type ResolvedCli } from "./cli";
import { isFlatpak } from "./flatpak";
import { Log } from "./log";

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ConnectionState = "connected" | "connecting" | "error";
export type CliResolver = () => Promise<ResolvedCli | undefined>;

/**
 * Owns the connection to the OpenCode V2 background service.
 *
 * Connection order:
 *  1. explicit `opencode2.server.baseUrl` (remote / already-running server)
 *  2. discovery of a healthy registered local service (`Service.discover`)
 *  3. start one when allowed (`opencode2.server.autoStart` → `Service.ensure`,
 *     which runs `<cli> serve --service` and registers it)
 *
 * The controller is the only place that talks to the server; the webview goes
 * through RPC (M2+).
 */
export class OpenCodeController implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ConnectionState>();
  private readonly eventEmitter = new vscode.EventEmitter<OpenCodeEvent>();
  private readonly resyncEmitter = new vscode.EventEmitter<void>();
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private client?: OpenCodeClient;
  private activeBaseUrl?: string;
  private generation = 0;
  private pumpToken = 0;

  // Connection self-healing: discovery/ensure or the health probe can hang on
  // first open (e.g. the background service is still starting). Without a bound
  // we'd sit on "connecting" forever and force a manual reload. So every attempt
  // is time-boxed and retried with backoff while auto-start is enabled.
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryCount = 0;
  private readonly connectTimeoutMs = 12_000;
  private readonly retryBaseMs = 4_000;
  private readonly maxRetries = 20;

  constructor(
    private readonly log: Log,
    private readonly resolveCli: CliResolver = () => Promise.resolve(undefined),
  ) {}

  readonly onDidChangeState = this.emitter.event;

  /** Raw V2 events, forwarded verbatim while connected. */
  readonly onEvent = this.eventEmitter.event;

  /**
   * Fired after a (re)connect. `/api/event` is volatile and lossy by contract,
   * so consumers must re-sync state from REST endpoints when this fires.
   */
  readonly onResync = this.resyncEmitter.event;

  get state(): ConnectionState {
    return this.client ? "connected" : this.lastError ? "error" : "connecting";
  }

  get baseUrl(): string | undefined {
    return this.activeBaseUrl;
  }

  /** Human-readable failure from the most recent connect attempt. */
  get lastErrorDetail(): string | undefined {
    return this.lastError;
  }

  private lastError?: string;

  /** Current client; throws when not connected — callers must handle. */
  getClient(): OpenCodeClient {
    if (!this.client) throw new Error("OpenCode service is not connected.");
    return this.client;
  }

  /** (Re)establish the connection. Safe to call repeatedly; later calls win. */
  async connect(cli?: ResolvedCli): Promise<OpenCodeClient> {
    const generation = ++this.generation;
    this.clearRetry();
    this.setConnecting();

    try {
      const { client, health } = await this.withTimeout(
        this.establish(cli, generation),
        this.connectTimeoutMs,
      );
      if (generation !== this.generation) return this.getClient(); // superseded
      this.client = client;
      this.lastError = undefined;
      this.retryCount = 0;
      this.emitter.fire("connected");
      this.log.info(
        `connected to ${this.activeBaseUrl} (service v${health.version}, pid ${health.pid})`,
      );
      this.startEventPump(client, generation);
      return client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("connection failed", error);
      if (generation === this.generation) {
        this.client = undefined;
        this.lastError = message;
        this.emitter.fire("error");
        this.scheduleRetry(generation, cli);
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /** Discover/start the service and verify it with a health probe. */
  private async establish(
    cli: ResolvedCli | undefined,
    generation: number,
  ): Promise<{
    client: OpenCodeClient;
    health: Awaited<ReturnType<OpenCodeClient["health"]["get"]>>;
  }> {
    const client = await this.createClient(cli);
    if (generation !== this.generation)
      throw new Error("connection superseded");
    const health = await client.health.get();
    if (generation !== this.generation)
      throw new Error("connection superseded");
    return { client, health };
  }

  /** Reject if `p` does not settle within `ms`; never leaks the timer. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`connection timed out after ${ms}ms`)),
        ms,
      );
      this.pendingTimers.add(timer);
    });
    return Promise.race([p, timeout]).finally(() => {
      clearTimeout(timer);
      this.pendingTimers.delete(timer);
    });
  }

  /** Auto-retry the connection while auto-start is enabled (backoff, capped). */
  private scheduleRetry(
    generation: number,
    cli: ResolvedCli | undefined,
  ): void {
    if (generation !== this.generation || this.client) return;
    const autoStart = vscode.workspace
      .getConfiguration("opencode2")
      .get<boolean>("server.autoStart", true);
    if (!autoStart) return;
    if (this.retryCount >= this.maxRetries) {
      this.log.warn(
        "connection retries exhausted — run 'OpenCode 2: Restart Background Service'",
      );
      return;
    }
    this.retryCount++;
    const delay = Math.min(
      this.retryBaseMs * 2 ** (this.retryCount - 1),
      30_000,
    );
    this.log.debug(
      `scheduling connection retry #${this.retryCount} in ${delay}ms`,
    );
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      this.retryTimer = undefined;
      if (generation !== this.generation || this.client) return;
      void this.connect(cli).catch(() => {
        /* next retry scheduled by connect() on failure */
      });
    }, delay);
    this.retryTimer = timer;
    this.pendingTimers.add(timer);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.pendingTimers.delete(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  async restart(): Promise<void> {
    this.generation++; // invalidate in-flight connects
    this.client = undefined;
    this.activeBaseUrl = undefined;
    await this.connect();
  }

  /**
   * Consume the SSE stream for as long as `client` is the active connection.
   * The stream is volatile: it ends on overflow/disconnect. We surface events
   * live, then reconnect with backoff and fire onResync so consumers can
   * refetch what they missed.
   */
  private startEventPump(client: OpenCodeClient, generation: number): void {
    const token = ++this.pumpToken;

    void (async () => {
      try {
        for await (const event of client.event.subscribe()) {
          if (token !== this.pumpToken || generation !== this.generation)
            return;
          this.eventEmitter.fire(event);
        }
        // Stream ended cleanly — treat like a drop and resync.
        throw new Error("event stream ended");
      } catch (error) {
        if (token !== this.pumpToken || generation !== this.generation) return;
        this.log.warn(
          `event stream dropped (${error instanceof Error ? error.message : String(error)}); resyncing`,
        );
        this.resyncEmitter.fire();
        this.scheduleReconnect(generation);
      }
    })();
  }

  private scheduleReconnect(generation: number): void {
    let attempt = 0;
    const backoff = (): void => {
      if (generation !== this.generation || this.client === undefined) return; // superseded or disposed
      const delay = Math.min(1000 * 2 ** attempt++, 15_000);
      this.log.debug(`event pump retry #${attempt} in ${delay}ms`);
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        void this.runPumpLoop(generation, backoff);
      }, delay);
      this.pendingTimers.add(timer);
    };
    backoff();
  }

  /** Keep only the event pump alive across drops (no full reconnect). */
  private async runPumpLoop(
    generation: number,
    onFail: () => void,
  ): Promise<void> {
    const client = this.client;
    if (!client || generation !== this.generation) return;
    try {
      const stream = client.event.subscribe()[Symbol.asyncIterator]();
      // Probe so a dead endpoint fails fast instead of hanging forever.
      await Promise.race([
        stream.next(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("subscribe probe timeout")),
            10_000,
          );
          this.pendingTimers.add(timer);
        }),
      ]);
      for await (const event of { [Symbol.asyncIterator]: () => stream }) {
        if (generation !== this.generation) return;
        this.eventEmitter.fire(event);
      }
      throw new Error("event stream ended");
    } catch (error) {
      if (generation !== this.generation) return;
      this.log.debug("pump loop failed", error);
      onFail();
    }
  }

  private async createClient(cli?: ResolvedCli): Promise<OpenCodeClient> {
    const config = vscode.workspace.getConfiguration("opencode2");
    const explicitUrl = config.get<string>("server.baseUrl", "").trim();
    const serverMode = config.get<"own" | "discover">("server.mode", "own");

    // 1) Explicit server URL wins — no auth headers are injected.
    if (explicitUrl) {
      this.log.debug(`using explicit server url: ${explicitUrl}`);
      return this.track(OpenCode.make({ baseUrl: explicitUrl }), explicitUrl);
    }

    // 2) "discover" mode: find an already-registered healthy service.
    if (serverMode === "discover") {
      const discovered = await Service.discover().catch((error: unknown) => {
        this.log.debug("discover failed", error);
        return undefined;
      });
      if (discovered) {
        this.log.debug(`discovered registered service at ${discovered.url}`);
        return this.makeFor(discovered);
      }
      throw new Error(
        "No running OpenCode service found in discover mode. Start one with `opencode serve` or switch opencode2.server.mode to 'own'.",
      );
    }

    // 3) "own" mode (default): spawn our own hidden background service.
    let spawnCommand: string[];
    if (cli) {
      spawnCommand = spawnArgvHost(cli, "serve", "--service");
    } else {
      const resolved = await this.resolveCli();
      if (!resolved) {
        throw new Error(
          isFlatpak()
            ? "OpenCode CLI not found on the host system. Flatpak detected — install the CLI on the host (not inside the sandbox): `npm install -g opencode-ai@beta`, or set opencode2.cliPath."
            : "OpenCode CLI not found for auto-start. Run 'OpenCode 2: Install CLI' or set opencode2.cliPath.",
        );
      }
      spawnCommand = spawnArgvHost(resolved, "serve", "--service");
    }
    this.log.debug(
      `starting hidden background service: ${spawnCommand.join(" ")}`,
    );
    await this.startHiddenService(spawnCommand);
    const endpoint = await this.waitForDiscovery();
    return this.makeFor(endpoint);
  }

  /** Spawn <cli> serve --service detached + hidden; resolves once spawned. */
  private async startHiddenService(spawnCommand: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.log.error("hidden service spawn failed", error);
        reject(error);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spawnCommand[0]!, spawnCommand.slice(1), {
          detached: true,
          stdio: "ignore",
          windowsHide: true, // CREATE_NO_WINDOW — suppresses the detached console window
          env: process.env,
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      child.once("error", fail);
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        this.log.info(
          `background service spawned (pid ${child.pid}); waiting for registration`,
        );
        resolve();
      });
      // The service is shared and intentionally outlives this extension host.
      child.unref();
    });
  }

  /** Poll Service.discover() until a healthy registration appears (≤15s). */
  private async waitForDiscovery(): Promise<Endpoint> {
    const deadline = Date.now() + 15_000;
    let delay = 400;
    while (Date.now() < deadline) {
      const endpoint = await Service.discover().catch((error: unknown) => {
        this.log.debug("discover during start failed", error);
        return undefined;
      });
      if (endpoint) {
        this.log.info(`background service registered at ${endpoint.url}`);
        return endpoint;
      }
      await sleep(delay);
      delay = Math.min(delay * 1.7, 2000);
    }
    throw new Error(
      "OpenCode service failed to register within 15s of starting it.",
    );
  }

  private makeFor(endpoint: Endpoint): OpenCodeClient {
    return this.track(
      OpenCode.make({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint),
      }),
      endpoint.url,
    );
  }

  private track(client: OpenCodeClient, url: string): OpenCodeClient {
    this.activeBaseUrl = url;
    return client;
  }

  private setConnecting(): void {
    this.client = undefined;
    this.lastError = undefined;
    this.emitter.fire("connecting");
  }

  dispose(): void {
    this.generation++;
    this.pumpToken++;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.emitter.dispose();
    this.eventEmitter.dispose();
    this.resyncEmitter.dispose();
  }
}
