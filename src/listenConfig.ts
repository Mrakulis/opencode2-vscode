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
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1"
  );
}

export function expectedAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}
