import path from "node:path";

/**
 * Win32 drive-letter canonicalization. VERIFIED LIVE 2026-08-26: the V2
 * server's instruction initializer crashes ("Maximum call stack size
 * exceeded" → Instructions.InitializationBlocked) when a session's location
 * carries a lowercase drive letter — every prompt on such a session then
 * silently fails to persist. Uppercasing the drive avoids it entirely.
 *
 * vscode-free so it stays unit-testable under plain node.
 */
export function canonicalizeDirectory(dir: string): string {
  if (process.platform !== "win32") return dir;
  const out = path.normalize(dir);
  // Drive letter sits directly before the COLON ("e:\..."), so anchor on
  // that — a separator lookahead after the letter never matches.
  return out.replace(/^[a-z](?=:)/, (c) => c.toUpperCase());
}
