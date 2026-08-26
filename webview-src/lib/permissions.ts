/**
 * Permission auto-respond — a faithful port of OpenCode's session auto-accept
 * semantics for our GUI (see packages/app/src/context/permission.tsx upstream).
 *
 * - Auto-accept replies `"once"` (approve this request only) exactly like the
 *   official app — it never auto-persists `"always"` rules, because tools may
 *   propose `*` patterns (the spec warns to review those carefully).
 * - A dedupe tracker (1h TTL, capped) stops us replying twice when the volatile
 *   event stream re-fires the same permission.asked.
 * - `question` actions are never auto-responded (they stay interactive).
 * - Server allow/deny rules always win: we only ever see `ask` results.
 */

export type PermissionMode = "askFirst" | "autoAllow" | "deny";

/** What to reply automatically, or undefined when the user should decide. */
export function autoReplyFor(
  mode: PermissionMode,
  action: string,
  sessionAutoAccepting = false,
): "once" | "reject" | undefined {
  if (action.toLowerCase() === "question") return undefined;
  // Anything outside the project folder must always surface, even in
  // auto-allow mode (matches OpenCode's own external_directory policy).
  // An explicit per-session auto-accept still bypasses the prompt.
  if (action.toLowerCase() === "external_directory" && !sessionAutoAccepting)
    return undefined;
  if (mode === "autoAllow") return "once";
  if (mode === "deny") return "reject";
  if (mode === "askFirst" && sessionAutoAccepting) return "once";
  return undefined;
}

export const PERMISSION_RESPONDED_TTL_MS = 60 * 60 * 1000; // 1 hour
export const PERMISSION_RESPONDED_MAX = 1000;

/** Dedupe tracker mirroring the upstream `responded` map (TTL + cap). */
export class RespondedTracker {
  private readonly map = new Map<string, number>();

  private prune(now: number): void {
    for (const [id, ts] of this.map) {
      if (now - ts >= PERMISSION_RESPONDED_TTL_MS) this.map.delete(id);
      else break; // insertion order = time order
    }
  }

  had(requestID: string): boolean {
    // Prune here too: on an idle webview no mark() fires, so expired entries
    // would otherwise survive forever and block auto-reply for retried asks.
    this.prune(Date.now());
    return this.map.has(requestID);
  }

  mark(requestID: string): void {
    const now = Date.now();
    this.prune(now);
    this.map.delete(requestID);
    this.map.set(requestID, now);
    for (const id of this.map.keys()) {
      if (this.map.size <= PERMISSION_RESPONDED_MAX) break;
      this.map.delete(id);
    }
  }

  clear(requestID: string): void {
    this.map.delete(requestID);
  }

  /** Ordered keys (insertion order) — exposed for unit tests. */
  order(): string[] {
    return [...this.map.keys()];
  }
}