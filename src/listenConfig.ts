/**
 * Pure helpers for the extension-owned listen server, kept vscode-free so
 * plain node tests can load them (same pattern as webview-src/lib/failure.ts).
 */

export interface ListenConfig {
  enabled: boolean;
  hostname: string;
  port: number;
  username: string;
  password: string;
  cors: string[];
}

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    h === "::ffff:127.0.0.1"
  );
}

export function expectedAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

/** Host portion of an HTTP `Host` header value — strips a numeric port,
 *  handles bracketed IPv6 ("[::1]:port") and bare IPv6 ("::1"). Returns
 *  undefined for a missing/empty header. */
export function parseHostHeader(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const value = host.trim();
  if (!value) return undefined;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? undefined : value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  if (colon === -1) return value;
  const port = value.slice(colon + 1);
  const head = value.slice(0, colon);
  // Only strip a port when the remainder is not itself bare IPv6 ("::1" —
  // bracketless with multiple colons, no port). An empty port ("host:")
  // also strips to the bare host instead of failing closed downstream.
  if (!head.includes(":") && (port === "" || /^\d+$/.test(port))) return head;
  return value;
}

/**
 * Build the externally-advertised companion URL. IPv6 literals must be
 * bracketed ("http://[::1]:12421") — a bare "http://::1:12421" is unparsable
 * by every HTTP client, so a `::1` bind previously advertised a dead URL.
 * Hosts that already carry brackets pass through untouched.
 */
export function formatListenUrl(hostname: string, port: number): string {
  const host = hostname.trim();
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}

/**
 * Interval between SSE keep-alive comment frames (`: ping`) injected by the
 * companion server while the upstream daemon is quiet. 15s sits under typical
 * NAT (30s) and mobile-radio (30-60s) idle kills — timeouts alone can't hold
 * an idle TCP socket open, only real bytes can.
 */
export const SSE_HEARTBEAT_MS = 15_000;

/** SSE-spec no-op comment frame — parsers ignore it, middleboxes see traffic. */
export const SSE_PING = ": ping\n\n";

/** True when an incoming proxy request is an SSE subscription. */
export function isSseRequest(
  method: string | undefined,
  url: string | undefined,
  accept: string | string[] | undefined,
): boolean {
  if (method !== "GET") return false;
  const pathname = (url ?? "/").split("?")[0];
  if (pathname === "/api/event" || pathname === "/event") return true;
  const a = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  return a.includes("text/event-stream");
}

/** True when an upstream response is an SSE stream. */
export function isSseResponse(contentType: string | string[] | undefined): boolean {
  const ct = Array.isArray(contentType) ? contentType.join(",") : (contentType ?? "");
  return ct.includes("text/event-stream");
}
