import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode-ai/client";
import { Service, type Endpoint, type EnsureReason } from "@opencode-ai/client/service";
import * as vscode from "vscode";
import type { ResolvedCli } from "./cli";
import { Log } from "./log";

export type ConnectionState = "connected" | "connecting" | "error";

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

  constructor(private readonly log: Log) {}

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

  private lastError?: string;

  /** Current client; throws when not connected — callers must handle. */
  getClient(): OpenCodeClient {
    if (!this.client) throw new Error("OpenCode service is not connected.");
    return this.client;
  }

  /** (Re)establish the connection. Safe to call repeatedly; later calls win. */
  async connect(cli?: ResolvedCli): Promise<OpenCodeClient> {
    const generation = ++this.generation;
    this.setConnecting();

    try {
      const client = await this.createClient(cli);
      if (generation !== this.generation) return this.getClient(); // superseded
      const health = await client.health.get();
      if (generation !== this.generation) return this.getClient();
      this.client = client;
      this.lastError = undefined;
      this.emitter.fire("connected");
      this.log.info(`connected to ${this.activeBaseUrl} (service v${health.version}, pid ${health.pid})`);
      this.startEventPump(client, generation);
      return client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("connection failed", error);
      if (generation === this.generation) {
        this.client = undefined;
        this.lastError = message;
        this.emitter.fire("error");
      }
      throw error instanceof Error ? error : new Error(message);
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
          if (token !== this.pumpToken || generation !== this.generation) return;
          this.eventEmitter.fire(event);
        }
        // Stream ended cleanly — treat like a drop and resync.
        throw new Error("event stream ended");
      } catch (error) {
        if (token !== this.pumpToken || generation !== this.generation) return;
        this.log.warn(`event stream dropped (${error instanceof Error ? error.message : String(error)}); resyncing`);
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
  private async runPumpLoop(generation: number, onFail: () => void): Promise<void> {
    const client = this.client;
    if (!client || generation !== this.generation) return;
    try {
      const stream = client.event.subscribe()[Symbol.asyncIterator]();
      // Probe so a dead endpoint fails fast instead of hanging forever.
      await Promise.race([
        stream.next(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("subscribe probe timeout")), 10_000);
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
    const autoStart = config.get<boolean>("server.autoStart", true);

    // 1) Explicit server URL wins — no auth headers are injected.
    if (explicitUrl) {
      this.log.debug(`using explicit server url: ${explicitUrl}`);
      return this.track(OpenCode.make({ baseUrl: explicitUrl }), explicitUrl);
    }

    // 2) Discover an already-registered healthy service.
    const discovered = await Service.discover().catch((error: unknown) => {
      this.log.debug("discover failed", error);
      return undefined;
    });
    if (discovered) {
      this.log.debug(`discovered registered service at ${discovered.url}`);
      return this.makeFor(discovered);
    }
    // 3) Start one via the CLI's `serve --service` mode.
    if (!autoStart) {
      throw new Error(
        "No running OpenCode service found and auto-start is disabled (opencode2.server.autoStart).",
      );
    }

    const command = cli?.command ?? "opencode2";
    this.log.debug(`ensuring service via command: ${command}`);
    const endpoint = await Service.ensure({
      command: [command, "serve", "--service"],
      onStart: (reason: EnsureReason, previousVersion?: string) =>
        this.log.info(`starting background service (${reason}${previousVersion ? `, was ${previousVersion}` : ""})`),
    });
    return this.makeFor(endpoint);
  }

  private makeFor(endpoint: Endpoint): OpenCodeClient {
    return this.track(OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }), endpoint.url);
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
