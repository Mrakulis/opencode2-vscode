import {
  OpenCode,
  type OpenCodeClient,
  type OpenCodeEvent,
} from "@opencode-ai/client";
import { Service, type Endpoint } from "@opencode-ai/client/service";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { spawnArgvHost, type ResolvedCli } from "./cli";
import { isFlatpak, registrationFiles } from "./flatpak";
import { Log } from "./log";

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when two service URLs point at the same local endpoint — hostnames
 * are normalized so `localhost`, `127.0.0.1`, and `[::1]` all match.
 */
export function sameServiceUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (h: string): string =>
      h === "127.0.0.1" || h === "[::1]" || h === "::1" ? "localhost" : h;
    return (
      ua.protocol === ub.protocol &&
      norm(ua.hostname) === norm(ub.hostname) &&
      ua.port === ub.port
    );
  } catch {
    return false;
  }
}

/** Thrown when a connect attempt is abandoned because a newer one started. */
class SupersededError extends Error {
  constructor() {
    super("connection superseded");
  }
}

export type ConnectionState = "connected" | "connecting" | "error";
export type CliResolver = () => Promise<ResolvedCli | undefined>;

/**
 * Owns the connection to the OpenCode V2 background service.
 *
 * Connection order:
 *  1. explicit `opencode2.server.baseUrl` (remote / already-running server)
 *  2. discovery of a healthy registered local service (`Service.discover`)
 *  3. start one when allowed (`opencode2.server.autoStart` → hidden spawn of
 *     `<cli> serve --service`, which registers it)
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
  private activeHeaders?: Record<string, string>;
  private generation = 0;
  private pumpToken = 0;

  // Connection self-healing: discovery/ensure or the health probe can hang on
  // first open (e.g. the background service is still starting). Without a bound
  // we'd sit on "connecting" forever and force a manual reload. So every attempt
  // is time-boxed and retried with backoff while auto-start is enabled.
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryCount = 0;
  private readonly connectTimeoutMs = 35_000;
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
  async connect(cli?: ResolvedCli, opts?: { force?: boolean }): Promise<OpenCodeClient> {
    const generation = ++this.generation;
    this.clearRetry();
    this.setConnecting();

    try {
      const { client, health } = await this.withTimeout(
        this.establish(cli, generation, opts?.force),
        this.connectTimeoutMs,
      );
      if (generation !== this.generation) {
        // Superseded mid-flight: the attempt itself may have SUCCEEDED, so do
        // not log/record a failure — a newer connect() owns the outcome.
        this.log.debug("connect superseded by a newer attempt");
        return client;
      }
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
      // Superseded attempts are not failures — a newer connect() owns the outcome.
      if (error instanceof SupersededError) {
        this.log.debug("connect superseded");
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("connection failed", error);
      if (generation === this.generation) {
        this.client = undefined;
        // Surface an actionable hint for auth challenges — a local service
        // always requires basic auth, and explicit URLs may lack credentials.
        const authHint =
          /401|unauthorized|authentication/i.test(message) &&
          !/basic auth/i.test(message)
            ? `${message} — the service requires basic auth; discovery supplies it automatically, or point opencode2.server.baseUrl at the exact registered URL.`
            : message;
        this.lastError = authHint;
        this.emitter.fire("error");
        this.scheduleRetry(generation, cli, opts?.force);
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /** Discover/start the service and verify it with a health probe. */
  private async establish(
    cli: ResolvedCli | undefined,
    generation: number,
    force?: boolean,
  ): Promise<{
    client: OpenCodeClient;
    health: Awaited<ReturnType<OpenCodeClient["health"]["get"]>>;
  }> {
    const client = await this.createClient(cli, force);
    if (generation !== this.generation) throw new SupersededError();
    const health = await client.health.get();
    if (generation !== this.generation) throw new SupersededError();
    return { client, health };
  }

  /** Reject if `p` does not settle within `ms`; never leaks the timer. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    // Mark the loser handled so a late settle after the race wins can't
    // surface as an unhandled rejection (establish/health probes).
    p.then(
      () => undefined,
      () => undefined,
    );
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
    force?: boolean,
  ): void {
    if (generation !== this.generation || this.client) return;
    const autoStart = vscode.workspace
      .getConfiguration("opencode2")
      .get<boolean>("server.autoStart", false);
    if (!autoStart && !force) return;
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
      void this.connect(cli, force ? { force } : undefined).catch(() => {
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

  async restart(opts?: { force?: boolean }): Promise<void> {
    this.generation++; // invalidate in-flight connects
    this.client = undefined;
    this.activeBaseUrl = undefined;
    await this.connect(undefined, opts?.force ? { force: true } : undefined);
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
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const probe = (await Promise.race([
          stream.next(),
          new Promise<never>((_, reject) => {
            probeTimer = setTimeout(
              () => reject(new Error("subscribe probe timeout")),
              10_000,
            );
            this.pendingTimers.add(probeTimer);
          }),
        ])) as IteratorResult<OpenCodeEvent>;
        // The probe consumes the first event — deliver it instead of dropping.
        if (!probe.done && probe.value) this.eventEmitter.fire(probe.value);
      } finally {
        if (probeTimer) {
          clearTimeout(probeTimer);
          this.pendingTimers.delete(probeTimer);
        }
      }
      try {
        for await (const event of { [Symbol.asyncIterator]: () => stream }) {
          if (generation !== this.generation) return;
          this.eventEmitter.fire(event);
        }
      } finally {
        // Release the daemon socket promptly on supersede/dispose.
        await stream.return?.().catch(() => undefined);
      }
      throw new Error("event stream ended");
    } catch (error) {
      if (generation !== this.generation) return;
      this.log.debug("pump loop failed", error);
      onFail();
    }
  }

  private async createClient(cli?: ResolvedCli, force?: boolean): Promise<OpenCodeClient> {
    const config = vscode.workspace.getConfiguration("opencode2");
    const explicitUrl = config.get<string>("server.baseUrl", "").trim();
    const serverMode = config.get<"own" | "discover">("server.mode", "own");

    // 1) Explicit server URL wins — no auth headers are injected for remote
    //    servers. Local services register with basic auth though, so when the
    //    explicit URL matches a local registration we reuse its credentials;
    //    otherwise every request 401s (a browser hitting the same URL shows
    //    the same username/password prompt).
    if (explicitUrl) {
      this.log.debug(`using explicit server url: ${explicitUrl}`);
      const headers = await this.headersForExplicit(explicitUrl);
      this.activeHeaders = headers ?? undefined;
      return this.track(
        headers
          ? OpenCode.make({ baseUrl: explicitUrl, headers })
          : OpenCode.make({ baseUrl: explicitUrl }),
        explicitUrl,
      );
    }

    // 2) "discover" mode: find an already-registered healthy service.
    if (serverMode === "discover") {
      const discovered = await this.discoverService();
      if (discovered) {
        this.log.debug(`discovered registered service at ${discovered.url}`);
        return this.makeFor(discovered);
      }
      throw new Error(
        "No running OpenCode service found in discover mode. Start one with `opencode serve` or switch opencode2.server.mode to 'own'.",
      );
    }

    // 3) "own" mode (default): reuse an existing healthy service before
    //    spawning a new one — every window reload would otherwise blind-spawn
    //    another detached service. `discoverService()` already health-checks
    //    via `Service.discover` (fetch /api/health), so a returned endpoint
    //    is healthy; stale registrations return undefined and fall through.
    const existing = await this.discoverService();
    if (existing) {
      this.log.debug(
        `own mode found an already-registered service at ${existing.url}`,
      );
      return this.makeFor(existing);
    }
    const autoStart = config.get<boolean>("server.autoStart", false);
    if (!autoStart && !force) {
      throw new Error(
        "No running OpenCode service found and opencode2.server.autoStart is disabled — press 'Start opencode2' or enable opencode2.server.autoStart.",
      );
    }
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
      let stderr = "";
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        const msg = stderr ? `${error.message}\n${stderr}` : error.message;
        const err = new Error(msg);
        (err as unknown as { cause?: unknown }).cause = (error as unknown as { cause?: unknown })?.cause ?? error;
        this.log.error("hidden service spawn failed", err);
        reject(err);
      };
      // Normalize shim spawns for true silent start: cmd.exe via /d /s /c
      // with quoted shim ensures CREATE_NO_WINDOW fully suppresses conhost
      // flash (plain /d /c without /s can still show a brief window on some
      // AV/Windows configs). Non-shim spawns (node/.exe) already hide cleanly.
      let spawnProg = spawnCommand[0]!;
      let spawnArgs = spawnCommand.slice(1);
      const isCmdShim =
        spawnProg.toLowerCase() === "cmd.exe" ||
        spawnProg.toLowerCase().endsWith("\\cmd.exe") ||
        spawnProg.toLowerCase().endsWith("/cmd.exe");
      if (isCmdShim && spawnArgs.length >= 3 && spawnArgs[0] === "/d" && spawnArgs[1] === "/c") {
        // Already handled in cli.ts describe, but normalize legacy /d /c to /d /s /c with quoted target
        const shimTarget = spawnArgs[2]!;
        const rest = spawnArgs.slice(3);
        const quotedTarget = shimTarget.startsWith('"') ? shimTarget : `"${shimTarget}"`;
        const cmdString = [quotedTarget, ...rest].join(" ");
        spawnArgs = ["/d", "/s", "/c", cmdString];
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spawnProg, spawnArgs, {
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true, // CREATE_NO_WINDOW — suppresses the detached console window
          shell: false,
          windowsVerbatimArguments: false,
          env: process.env,
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8").slice(-8000);
      });
      if (child.stderr && typeof (child.stderr as unknown as { unref?: () => void }).unref === "function") {
        (child.stderr as unknown as { unref: () => void }).unref();
      }
      child.once("error", fail);
      child.once("close", (code, signal) => {
        if (!settled && code !== 0 && code !== null) {
          fail(new Error(`service process exited with code ${code}${signal ? ` signal ${signal}` : ""}`));
        }
      });
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

  /** Poll discoverService() until a healthy registration appears (≤30s). */
  private async waitForDiscovery(): Promise<Endpoint> {
    const deadline = Date.now() + 30_000;
    let delay = 400;
    while (Date.now() < deadline) {
      const endpoint = await this.discoverService();
      if (endpoint) {
        this.log.info(`background service registered at ${endpoint.url}`);
        return endpoint;
      }
      await sleep(delay);
      delay = Math.min(delay * 1.7, 2000);
    }
    throw new Error(
      "OpenCode service failed to register within 30s of starting it — check opencode2.cliPath and Output channel.",
    );
  }

  /** Probe a discovered endpoint's health (bounded) before reusing it. */
  private async isHealthy(endpoint: Endpoint): Promise<boolean> {
    try {
      const probe = OpenCode.make({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint),
      });
      const health = await Promise.race([
        probe.health.get(),
        sleep(3_000).then(() => {
          throw new Error("health probe timed out");
        }),
      ]);
      return health?.healthy === true;
    } catch (error) {
      this.log.debug(
        `health probe ${endpoint.url} failed`,
        error instanceof Error ? error : new Error(String(error)),
      );
      return false;
    }
  }

  private makeFor(endpoint: Endpoint): OpenCodeClient {
    this.activeHeaders = Service.headers(endpoint) as unknown as Record<string, string>;
    return this.track(
      OpenCode.make({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint),
      }),
      endpoint.url,
    );
  }

  /**
   * Discover a healthy registered service across every plausible registration
   * file. The library default derives the path from XDG_STATE_HOME, which
   * Flatpak sandboxes redirect to the app-private dir while a HOST-spawned
   * service registers at the real ~/.local/state — so under Flatpak we probe
   * host-canonical locations first.
   */
  private async discoverService(): Promise<Endpoint | undefined> {
    for (const file of registrationFiles()) {
      const found = await Service.discover({ file }).catch(
        (error: unknown) => {
          this.log.debug(`discover ${file} failed`, error);
          return undefined;
        },
      );
      if (found) {
        this.log.debug(`discovered registered service via ${file}`);
        return found;
      }
    }
    return undefined;
  }

  /**
   * Auth headers for an explicit `server.baseUrl`. Only loopback URLs are
   * candidates: if a local registration exists for the same endpoint, its
   * basic-auth credentials are reused. Remote URLs stay credential-free.
   */
  private async headersForExplicit(
    url: string,
  ): Promise<Record<string, string> | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    const host = parsed.hostname;
    // WHATWG URL keeps brackets on IPv6 literals (`[::1]`), and Windows may
    // surface IPv4-mapped `::ffff:127.0.0.1` — normalize both before matching.
    const bare =
      host.startsWith("[") && host.endsWith("]")
        ? host.slice(1, -1).toLowerCase()
        : host.toLowerCase();
    const loopback =
      bare === "localhost" ||
      bare === "127.0.0.1" ||
      bare === "::1" ||
      bare === "::ffff:127.0.0.1";
    if (!loopback) return undefined;
    const discovered = await this.discoverService();
    if (!discovered?.auth) return undefined;
    if (!sameServiceUrl(discovered.url, url)) return undefined;
    this.log.debug(
      `explicit url matches local registration at ${discovered.url}; attaching its auth`,
    );
    return Service.headers(discovered);
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
