/**
 * Subagent tracking helpers — pure and unit-testable.
 *
 * V2 has no `subagent.*` events: a subagent run is a child session carrying
 * `parentID` (verified against the pinned SDK's session.created payload).
 * Activity is derived from Session.Info.time.idle (set when the run settles).
 */

export interface SubagentSession {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  cost?: number;
  time: { created: number; updated: number; idle?: number; archived?: number };
}

/** Child sessions of `parentID`, newest activity first. */
export function childrenOf<T extends SubagentSession>(
  sessions: T[],
  parentID: string | undefined,
): T[] {
  if (!parentID) return [];
  return sessions
    .filter((s) => s.parentID === parentID)
    .sort((a, b) => b.time.updated - a.time.updated);
}

/** True when the subagent run has not settled yet (no idle timestamp). */
export function isSubagentActive(s: SubagentSession): boolean {
  if (s.time.archived !== undefined) return false;
  return s.time.idle === undefined;
}
