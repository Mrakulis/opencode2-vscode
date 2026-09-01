import * as http from "node:http";
import * as https from "node:https";
import { timingSafeEqual } from "node:crypto";
import * as vscode from "vscode";
import { Service, type Endpoint } from "@opencode-ai/client/service";
import { registrationFiles } from "./flatpak";
import { Log } from "./log";

export interface ListenConfig {
  enabled: boolean;
  hostname: string;
  port: number;
  username: string;
  password: string;
  cors: string[];
}

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

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1";
}

function expectedAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
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

  constructor(
    private readonly log: Log,
    daemonStarter?: () => Promise<void>,
  ) {
    this.daemonStarter = daemonStarter;
  }

  setDaemonStarter(fn: () => Promise<void>): void {
    this.daemonStarter = fn;
  }

  get url(): string | undefined {
    return this.activeUrl;
  }

  get isRunning(): boolean {
    return !!this.server?.listening;
  }

  async start(config?: ListenConfig): Promise<void> {
    const cfg = config ?? readListenConfig();
    if (!cfg.enabled) {
      await this.stop();
      return;
    }

    // Guard: 0.0.0.0 without password is refused
    if (!isLoopback(cfg.hostname) && !cfg.password) {
      const msg = `Extension server refused to bind ${cfg.hostname}:${cfg.port} without a password — set opencode2.server.listenPassword or use 127.0.0.1`;
      this.log.error(msg);
      void vscode.window.showErrorMessage(msg);
      await this.stop();
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

    await this.stop();

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res, cfg);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const msg = `Extension server port ${cfg.port} already in use — another VS Code window may already host it. Remote clients should use that window's URL.`;
        this.log.warn(msg);
        void vscode.window.showWarningMessage(msg);
      } else {
        this.log.error(`Extension server error: ${err.message}`, err);
        void vscode.window.showErrorMessage(`Extension server error: ${err.message}`);
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(cfg.port, cfg.hostname, () => resolve());
      server.once("error", reject);
    });

    this.server = server;
    this.activeConfig = cfg;
    const url = `http://${cfg.hostname}:${cfg.port}`;
    this.activeUrl = url;
    this.log.info(`Extension server listening at ${url} (auth: ${cfg.password ? "password" : "none"})`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      this.activeUrl = undefined;
      this.activeConfig = undefined;
      return;
    }
    const s = this.server;
    this.server = undefined;
    this.activeUrl = undefined;
    this.activeConfig = undefined;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
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
        res.end(JSON.stringify({ ok: true, url: ep?.url ?? null }));
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

    // Stream request body
    req.pipe(proxyReq);
  }

  dispose(): void {
    void this.stop();
  }
}
