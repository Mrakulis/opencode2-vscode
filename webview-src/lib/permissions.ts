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

  had(requestID: string, now: number = Date.now()): boolean {
    // Prune here too: on an idle webview no mark() fires, so expired entries
    // would otherwise survive forever and block auto-reply for retried asks.
    this.prune(now);
    return this.map.has(requestID);
  }

  mark(requestID: string, now: number = Date.now()): void {
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

/**
 * Request IDs (excluding `excludeRequestID`) that are still pending in the same
 * session. Used to honour OpenCode's "rejecting one request rejects all pending
 * in the session" contract when the user rejects a permission.
 */
export function sameSessionPending(
  list: { sessionID: string; requestID: string }[],
  sessionID: string,
  excludeRequestID: string,
): string[] {
  return list
    .filter((p) => p.sessionID === sessionID && p.requestID !== excludeRequestID)
    .map((p) => p.requestID);
}

/**
 * On an authoritative re-sync the server's pending list is ground truth. Any
 * request we previously marked "responded" that the server STILL lists as
 * pending had its reply lost (SSE drop / in-flight race). This returns the
 * still-pending ids whose stale mark should be cleared so the auto-reply
 * effect re-sends them instead of wedging the command forever.
 */
export function lostReplyIds(
  tracker: RespondedTracker,
  pendingIds: Iterable<string>,
): string[] {
  const lost: string[] = [];
  for (const id of pendingIds) {
    if (tracker.had(id)) lost.push(id);
  }
  return lost;
}