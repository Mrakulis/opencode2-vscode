import * as http from "node:http";
import * as https from "node:https";
import { timingSafeEqual } from "node:crypto";
import * as vscode from "vscode";
import { Service, type Endpoint } from "@opencode-ai/client/service";
import { registrationFiles } from "./flatpak";
import { Log } from "./log";
import {
  expectedAuthHeader,
  formatListenUrl,
  isLoopback,
  isSseRequest,
  isSseResponse,
  parseHostHeader,
  SSE_HEARTBEAT_MS,
  SSE_PING,
  type ListenConfig,
} from "./listenConfig";

// Pure pieces live vscode-free in ./listenConfig so node tests can import them.
export function readListenConfig(): ListenConfig {
  const cfg = vscode.workspace.getConfiguration("opencode2");
  return {
    enabled: cfg.get<boolean>("server.listenEnabled", false),
    hostname: cfg.get<string>("server.listenHostname", "127.0.0.1").trim() || "127.0.0.1",
    port: cfg.get<number>("server.listenPort", 12421) ?? 12421,
    username: cfg.get<string>("server.listenUsername", "opencode").trim() || "opencode",
    password: cfg.get<string>("server.listenPassword", "") ?? "",
    cors: cfg.get<string[]>("server.listenCors", []) ?? [],
  };
}

async function discoverLocalEndpoint(log: Log): Promise<Endpoint | undefined> {
  for (const file of registrationFiles()) {
    const found = await Service.discover({ file }).catch((error: unknown) => {
      log.debug(`extensionServer discover ${file} failed`, error);
      return undefined;
    });
    if (found) return found;
  }
  return undefined;
}

export class ExtensionServer implements vscode.Disposable {
  private server?: http.Server;
  private activeConfig?: ListenConfig;
  private activeUrl?: string;
  private daemonStarter?: () => Promise<void>;
  /**
   * Serializes start/stop. `companion.update` calls start() directly while the
   * same config write fires onDidChangeConfiguration -> syncExtensionServer();
   * without the chain those concurrent starts race into double server
   * creation, spurious EADDRINUSE warnings and leaked listeners.
   */
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: Log,
    daemonStarter?: () => Promise<void>,
  ) {
    this.daemonStarter = daemonStarter;
  }

  get url(): string | undefined {
    return this.activeUrl;
  }

  get isRunning(): boolean {
    return !!this.server?.listening;
  }

  start(config?: ListenConfig): Promise<void> {
    const run = this.lifecycle.then(() => this.doStart(config));
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  stop(): Promise<void> {
    const run = this.lifecycle.then(() => this.doStop());
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async doStart(config?: ListenConfig): Promise<void> {
    const cfg = config ?? readListenConfig();
    if (!cfg.enabled) {
      await this.doStop();
      return;
    }

    // Guard: 0.0.0.0 without password is refused
    if (!isLoopback(cfg.hostname) && !cfg.password) {
      const msg = `Extension server refused to bind ${cfg.hostname}:${cfg.port} without a password — set opencode2.server.listenPassword or use 127.0.0.1`;
      this.log.error(msg);
      void vscode.window.showErrorMessage(msg);
      await this.doStop();
      return;
    }

    // If already running with same config, keep it
    if (
      this.server?.listening &&
      this.activeConfig &&
      this.activeConfig.hostname === cfg.hostname &&
      this.activeConfig.port === cfg.port &&
      this.activeConfig.username === cfg.username &&
      this.activeConfig.password === cfg.password &&
      JSON.stringify(this.activeConfig.cors) === JSON.stringify(cfg.cors)
    ) {
      return;
    }

    await this.doStop();

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res, cfg);
    });

    // Long-lived SSE streams (phone notifications) die on idle TCP without
    // real bytes — timeouts alone can't hold them. Disable the idle request
    // timeout globally (REST responses are short anyway) and rely on the
    // per-SSE `: ping` heartbeat below for keep-alive.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 30_000;
    server.timeout = 0;
    server.on("connection", (socket) => {
      try {
        socket.setKeepAlive(true, 15_000);
        socket.setNoDelay(true);
      } catch {}
    });

    // Single notification path: there is no permanent handler during listen,
    // so a failed bind is logged + shown exactly once here before the
    // rejection surfaces to the caller (command progress / drawer).
    await new Promise<void>((resolve, reject) => {
      const onListenError = (err: Error): void => reject(err);
      server.once("error", onListenError);
      server.listen(cfg.port, cfg.hostname, () => {
        server.off("error", onListenError);
        resolve();
      });
    }).catch((err: NodeJS.ErrnoException) => {
      if (err?.code === "EADDRINUSE") {
        const msg = `Extension server port ${cfg.port} already in use — another VS Code window may already host it. Remote clients should use that window's URL.`;
        this.log.warn(msg);
        void vscode.window.showWarningMessage(msg);
      } else {
        this.log.error(
          `Extension server error: ${err?.message ?? String(err)}`,
          err,
        );
        void vscode.window.showErrorMessage(
          `Extension server error: ${err?.message ?? String(err)}`,
        );
      }
      throw err;
    });

    // Runtime errors after a successful listen.
    server.on("error", (err: NodeJS.ErrnoException) => {
      this.log.error(`Extension server error: ${err.message}`, err);
      void vscode.window.showErrorMessage(`Extension server error: ${err.message}`);
    });

    this.server = server;
    this.activeConfig = cfg;
    const url = formatListenUrl(cfg.hostname, cfg.port);
    this.activeUrl = url;
    this.log.info(`Extension server listening at ${url} (auth: ${cfg.password ? "password" : "none"})`);
  }

  private async doStop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.activeUrl = undefined;
    this.activeConfig = undefined;
    if (!s) return;
    await new Promise<void>((resolve) => {
      try {
        s.close(() => resolve());
      } catch {
        resolve(); // not running (e.g. closed before listen resolved)
      }
      // force close after 2s
      setTimeout(() => {
        try {
          s.closeAllConnections?.();
        } catch {}
        resolve();
      }, 2000).unref?.();
    });
    this.log.info("Extension server stopped");
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, cfg: ListenConfig): Promise<void> {
    try {
      await this.handleRequestInner(req, res, cfg);
    } catch (e) {
      // Never leave a request hanging: an unexpected throw (e.g. a malformed
      // discovery URL) used to become an unhandled rejection + dead socket.
      this.log.error("extensionServer request handler failed", e);
      if (!res.headersSent) {
        const origin = req.headers.origin;
        if (typeof origin === "string" && (cfg.cors.includes(origin) || cfg.cors.includes("*"))) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Credentials", "true");
          res.setHeader("Vary", "Origin");
        }
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      } else {
        try { res.end(); } catch {}
      }
    }
  }

  private async handleRequestInner(req: http.IncomingMessage, res: http.ServerResponse, cfg: ListenConfig): Promise<void> {
    // Host header validation first: a DNS-rebinding request resolves to this
    // port but arrives with a foreign Host and NO Origin header, which the
    // Origin gate below cannot catch. HTTP/1.1 requires Host; loopback binds
    // must see a loopback host. Non-loopback binds (password mandatory)
    // accept any Host — LAN/Tailscale names are legitimate there and the
    // Basic auth gates them.
    const hostHeader = parseHostHeader(req.headers.host);
    if (!hostHeader) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing Host header");
      return;
    }
    if (isLoopback(cfg.hostname) && !isLoopback(hostHeader)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Suspicious Host header (possible DNS rebinding)");
      return;
    }

    // CORS preflight handling
    const origin = req.headers.origin as string | undefined;
    const corsAllowed = origin && (cfg.cors.includes(origin) || cfg.cors.includes("*"));

    const setCorsHeaders = (): void => {
      if (!origin) return;
      if (corsAllowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      }
    };

    if (req.method === "OPTIONS") {
      setCorsHeaders();
      if (corsAllowed) {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        const reqHeaders = req.headers["access-control-request-headers"];
        if (typeof reqHeaders === "string") res.setHeader("Access-Control-Allow-Headers", reqHeaders);
        else res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        // Cache preflight so browser clients stop re-preflighting every request.
        res.setHeader("Access-Control-Max-Age", "600");
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Browser "simple requests" (GET / text/plain POST) skip preflight, so an
    // Origin we did not allow must never be proxied — the daemon auth is
    // injected here server-side and CORS alone only blocks reading responses.
    if (origin && !corsAllowed) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Origin not allowed");
      return;
    }

    // Auth check — static password, timing-safe compare (sufficient, not high-profile)
    if (cfg.password) {
      const auth = req.headers.authorization as string | undefined;
      const expected = expectedAuthHeader(cfg.username, cfg.password);
      const a = Buffer.from(auth ?? "");
      const b = Buffer.from(expected);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) {
        setCorsHeaders();
        res.setHeader("WWW-Authenticate", 'Basic realm="OpenCode"');
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }
    }

    // Extension-owned control routes (handled locally, not proxied)
    // Lets the phone start the daemon the same way the Start button does.
    const pathname = (req.url ?? "/").split("?")[0];
    // Phone reconnect probe: auth'd, never 502s. Lets the companion app
    // distinguish "companion down" (TCP refuse) from "daemon down"
    // (`daemonUp:false`) from "idle SSE drop" (health ok, just resubscribe).
    if (pathname === "/opencode2/health") {
      if (req.method !== "GET") {
        setCorsHeaders();
        res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET" });
        res.end("Method Not Allowed — GET /opencode2/health");
        return;
      }
      const ep = await discoverLocalEndpoint(this.log);
      setCorsHeaders();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, companion: true, daemonUp: !!ep, daemon: ep?.url ?? null }));
      return;
    }
    if (pathname === "/opencode2/extension/start" || pathname === "/opencode2/start") {
      if (req.method !== "POST") {
        setCorsHeaders();
        res.writeHead(405, { "Content-Type": "text/plain", Allow: "POST" });
        res.end("Method Not Allowed — POST /opencode2/extension/start");
        return;
      }
      if (!this.daemonStarter) {
        setCorsHeaders();
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Daemon starter not available");
        return;
      }
      try {
        await this.daemonStarter();
        const ep = await discoverLocalEndpoint(this.log);
        setCorsHeaders();
        res.writeHead(200, { "Content-Type": "application/json" });
        // `url` must be reachable by the caller (the companion itself) — the
        // daemon endpoint is loopback-only and goes out as informational.
        res.end(
          JSON.stringify({
            ok: true,
            url: this.activeUrl ?? formatListenUrl(cfg.hostname, cfg.port),
            daemon: ep?.url ?? null,
          }),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.error("remote daemon start failed", e);
        setCorsHeaders();
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Start failed: ${msg}`);
      }
      return;
    }

    // Unknown /opencode2/* paths are extension-owned namespace: fail locally
    // with a clear 404 instead of forwarding the typo to the daemon (which
    // would surface an unrelated daemon 404 and misdirect debugging).
    if (pathname === "/opencode2" || pathname?.startsWith("/opencode2/")) {
      setCorsHeaders();
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found — unknown /opencode2/ route (extension-owned namespace)");
      return;
    }

    // Discover local daemon (SSE streaming is chunked pipe, no polling — reliable route)
    const sseDownstream = isSseRequest(req.method, req.url, req.headers.accept);
    if (sseDownstream) {
      // Idle SSE sockets must never hit a server idle timeout, and TCP
      // keep-alive + Nagle-off keeps wakeups prompt for notifications.
      try {
        req.socket.setKeepAlive(true, 15_000);
        req.socket.setNoDelay(true);
      } catch {}
      try {
        req.setTimeout(0);
        res.setTimeout(0);
      } catch {}
    }
    const endpoint = await discoverLocalEndpoint(this.log);
    if (!endpoint) {
      setCorsHeaders();
      res.writeHead(502, { "Content-Type": "text/plain", "Retry-After": "2" });
      res.end("No local Opencode service available — is it running? Try 'Restart Background Service' in VS Code.");
      return;
    }

    // Build upstream request
    const targetUrl = new URL(endpoint.url);
    const targetPath = req.url ?? "/";

    // Prepare upstream headers: copy incoming, strip hop-by-hop, inject daemon auth
    const upstreamHeaders: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === "host" || lk === "connection" || lk === "keep-alive" || lk === "proxy-connection" || lk === "transfer-encoding" || lk === "upgrade") continue;
      if (lk === "origin" || lk === "referer") continue; // don't leak
      upstreamHeaders[k] = v as string | string[] | undefined;
    }
    // inject daemon auth, overriding any incoming Authorization
    const daemonHeaders = Service.headers(endpoint);
    if (daemonHeaders?.authorization) upstreamHeaders["authorization"] = daemonHeaders.authorization;
    else delete upstreamHeaders["authorization"];
    upstreamHeaders["host"] = targetUrl.host;

    const isHttps = targetUrl.protocol === "https:";
    const proxyMod = isHttps ? https : http;

    const proxyReq = proxyMod.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80,
        path: targetPath,
        method: req.method,
        headers: upstreamHeaders as Record<string, string | string[]>,
      },
      (proxyRes) => {
        setCorsHeaders();
        const sse = sseDownstream || isSseResponse(proxyRes.headers["content-type"]);
        // Filter hop-by-hop response headers
        const outHeaders: Record<string, string | string[] | number | undefined> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          const lk = k.toLowerCase();
          if (lk === "connection" || lk === "keep-alive" || lk === "proxy-authenticate" || lk === "proxy-authorization" || lk === "te" || lk === "trailer" || lk === "transfer-encoding" || lk === "upgrade") continue;
          // SSE streams are endless — a stale upstream content-length would
          // pin the phone at "waiting for N bytes" forever.
          if (sse && lk === "content-length") continue;
          outHeaders[k] = v as string | string[] | undefined;
        }
        if (sse) {
          outHeaders["content-type"] = "text/event-stream";
          outHeaders["cache-control"] = "no-cache";
          outHeaders["connection"] = "keep-alive";
          outHeaders["x-accel-buffering"] = "no";
        }
        if (corsAllowed && origin) {
          outHeaders["access-control-allow-origin"] = origin;
          outHeaders["access-control-allow-credentials"] = "true";
          outHeaders["vary"] = "Origin";
        }
        res.writeHead(proxyRes.statusCode ?? 502, outHeaders as Record<string, string | string[]>);
        if (!sse) {
          proxyRes.pipe(res);
          return;
        }
        // SSE keep-alive: while the daemon is quiet, middleboxes (NAT, mobile
        // radio, Tailscale) kill the idle socket. Inject a spec no-op comment
        // every SSE_HEARTBEAT_MS so the same socket that carries notifications
        // stays open. Skipped whenever upstream recently sent real bytes.
        try {
          res.flushHeaders?.();
        } catch {}
        const startedAt = Date.now();
        let bytes = 0;
        let lastUpstreamAt = Date.now();
        let ended = false;
        const clientIp = req.socket.remoteAddress ?? "?";
        this.log.info(`extensionServer SSE open (${clientIp} ${targetPath})`);
        const onData = (chunk: Buffer): void => {
          bytes += chunk.length;
          lastUpstreamAt = Date.now();
        };
        proxyRes.on("data", onData);
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const done = (reason: string): void => {
          if (ended) return;
          ended = true;
          if (heartbeat) {
            try {
              clearInterval(heartbeat);
            } catch {}
            heartbeat = undefined;
          }
          try {
            proxyRes.off("data", onData);
          } catch {}
          this.log.info(
            `extensionServer SSE close (${clientIp} ${targetPath} after ${Math.round((Date.now() - startedAt) / 1000)}s, ${bytes}B, ${reason})`,
          );
        };
        heartbeat = setInterval(() => {
          if (ended || res.writableEnded || res.destroyed) {
            done("client-gone");
            return;
          }
          if (Date.now() - lastUpstreamAt < SSE_HEARTBEAT_MS) return;
          // Backpressure: a full buffer means a slow/gone client — skip this
          // tick and retry next interval rather than piling up pings.
          try {
            res.write(SSE_PING);
          } catch {
            done("heartbeat-write-failed");
            try {
              proxyReq.destroy();
            } catch {}
          }
        }, SSE_HEARTBEAT_MS);
        try {
          heartbeat.unref?.();
        } catch {}
        proxyRes.on("end", () => {
          done("upstream-end");
          try {
            res.end();
          } catch {}
        });
        proxyRes.on("error", () => {
          done("upstream-error");
          try {
            res.end();
          } catch {}
        });
        res.on("close", () => {
          done(res.writableEnded ? "completed" : "client-abort");
          if (!res.writableEnded) {
            try {
              proxyReq.destroy();
            } catch {}
          }
        });
        proxyRes.pipe(res);
      },
    );

    try {
      proxyReq.setTimeout(0);
      proxyReq.setNoDelay?.(true);
    } catch {}
    proxyReq.on("socket", (socket) => {
      try {
        socket.setKeepAlive(true, 15_000);
        socket.setNoDelay(true);
      } catch {}
    });

    proxyReq.on("error", (err) => {
      this.log.debug(`extensionServer proxy error: ${err.message}`, err);
      if (!res.headersSent) {
        setCorsHeaders();
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Upstream error: ${err.message}`);
      } else {
        try { res.end(); } catch {}
      }
    });

    // Client disconnects must tear down the upstream socket — an aborted SSE
    // subscription would otherwise keep the daemon streaming into a dead res.
    // (SSE streams register their own close handler with logging above.)
    const abortUpstream = (): void => {
      try {
        proxyReq.destroy();
      } catch {}
    };
    if (!sseDownstream) {
      res.on("close", () => {
        if (!res.writableEnded) abortUpstream();
      });
    }
    req.on("error", abortUpstream);

    // Stream request body
    req.pipe(proxyReq);
  }

  dispose(): void {
    void this.stop();
  }
}
