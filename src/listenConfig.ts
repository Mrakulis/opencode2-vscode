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
