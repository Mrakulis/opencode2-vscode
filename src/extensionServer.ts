import * as http from "node:http";
import * as https from "node:https";
import { timingSafeEqual } from "node:crypto";
import * as vscode from "vscode";
import { Service, type Endpoint } from "@opencode-ai/client/service";
import { registrationFiles } from "./flatpak";
import { Log } from "./log";
import {
  expectedAuthHeader,
  isLoopback,
  parseHostHeader,
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
    const url = `http://${cfg.hostname}:${cfg.port}`;
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
            url: this.activeUrl ?? `http://${cfg.hostname}:${cfg.port}`,
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

    // Discover local daemon (SSE streaming is chunked pipe, no polling — reliable route)
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
        // Filter hop-by-hop response headers
        const outHeaders: Record<string, string | string[] | number | undefined> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          const lk = k.toLowerCase();
          if (lk === "connection" || lk === "keep-alive" || lk === "proxy-authenticate" || lk === "proxy-authorization" || lk === "te" || lk === "trailer" || lk === "transfer-encoding" || lk === "upgrade") continue;
          outHeaders[k] = v as string | string[] | undefined;
        }
        if (corsAllowed && origin) {
          outHeaders["access-control-allow-origin"] = origin;
          outHeaders["access-control-allow-credentials"] = "true";
          outHeaders["vary"] = "Origin";
        }
        res.writeHead(proxyRes.statusCode ?? 502, outHeaders as Record<string, string | string[]>);
        proxyRes.pipe(res);
      },
    );

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
    const abortUpstream = (): void => {
      proxyReq.destroy();
    };
    res.on("close", () => {
      if (!res.writableEnded) abortUpstream();
    });
    req.on("error", abortUpstream);

    // Stream request body
    req.pipe(proxyReq);
  }

  dispose(): void {
    void this.stop();
  }
}
