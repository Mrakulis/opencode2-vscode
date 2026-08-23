/**
 * Explicit router for the V2 event union (Q18: wire ALL valuable events).
 *
 * Pure and dependency-free so the routing table stays unit-testable; App.tsx
 * executes the returned actions against its own refreshers. TUI and
 * Installation events are deliberately ignored (they belong to the V2 TUI
 * client / CLI self-update — see AUDIT_AND_PLAN.md section 3.3).
 */

export type UiAction =
  | "sessions" // debounced session-list refetch
  | "messages" // debounced message refetch for the touched session
  | "pickers" // models/agents/default refetch
  | "permissions" // pending-permission sync
  | "forms" // pending-form sync
  | "mcp" // MCP drawer tick
  | "providers" // Providers drawer tick
  | "vcs" // branch chip / diff refresh
  | "worktrees" // worktree drawer tick
  | "instructions" // instructions drawer tick
  | "commands"; // slash-catalog reload

const TABLE: Record<string, UiAction[]> = {
  // execution lifecycle
  "session.execution.started": ["sessions", "messages"],
  "session.execution.succeeded": ["sessions", "messages"],
  "session.execution.failed": ["sessions", "messages"],
  "session.execution.interrupted": ["sessions", "messages"],
  "session.idle": ["sessions", "messages"],
  "session.status": ["sessions"],

  // streaming (deltas are handled by the accumulator, not refetches)
  "session.step.started": [],
  "session.step.ended": ["messages"],
  "session.step.failed": ["messages"],
  "session.text.started": ["messages"],
  "session.text.delta": [],
  "session.text.ended": ["messages"],
  "session.reasoning.started": ["messages"],
  "session.reasoning.delta": [],
  "session.reasoning.ended": ["messages"],
  "session.tool.input.started": [],
  "session.tool.input.delta": [],
  "session.tool.input.ended": ["messages"],
  "session.tool.called": ["messages"],
  "session.tool.progress": [],
  "session.tool.success": ["messages"],
  "session.tool.failed": ["messages"],

  // session metadata
  "session.created": ["sessions"],
  "session.deleted": ["sessions"],
  "session.renamed": ["sessions"],
  "session.moved": ["sessions"],
  "session.forked": ["sessions"],
  "session.agent.selected": ["sessions"],
  "session.model.selected": ["sessions"],
  "session.viewed": [],

  // usage & context
  "session.usage.recorded": ["sessions"],
  "session.usage.updated": [],

  // compaction
  "session.compaction.started": ["messages"],
  "session.compaction.delta": [],
  "session.compaction.ended": ["sessions", "messages"],
  "session.compaction.failed": ["messages"],

  // revert (undo/redo)
  "session.revert.staged": ["messages", "vcs"],
  "session.revert.cleared": ["messages", "vcs"],
  "session.revert.committed": ["sessions", "messages", "vcs"],

  // inbox (queued follow-ups)
  "session.inbox.delivered": ["messages"],
  "session.inbox.enqueued": ["sessions"],
  "session.inbox.cancelled": ["sessions"],
  "session.inbox.delivery.changed": ["sessions"],

  // skills / shells
  "session.skill.activated": ["messages"],
  "session.shell.started": ["messages"],
  "session.shell.ended": ["messages"],
  "session.synthetic": ["messages"],

  // permissions & forms
  "permission.asked": ["permissions"],
  "permission.replied": ["permissions"],
  "form.created": ["forms"],
  "form.replied": ["forms"],
  "form.cancelled": ["forms"],

  // environment surfaces
  "mcp.status.changed": ["mcp"],
  "mcp.resources.changed": ["mcp"],
  "integration.updated": ["providers"],
  "integration.connection.updated": ["providers"],
  "config.updated": [],
  "command.updated": ["commands"],
  "skill.updated": ["commands"],
  "plugin.added": [],
  "plugin.updated": [],
  "reference.updated": [],
  "websearch.updated": [],
  "vcs.branch.updated": ["vcs"],
  "worktree.updated": ["worktrees", "sessions"],
  "worktree.resolved": ["worktrees"],
  "server.connected": ["pickers"],
};

/** Actions the UI should run for one incoming V2 event type. */
export function actionsForEvent(type: string): UiAction[] {
  return TABLE[type] ?? [];
}

/** True when the event targets a specific session we can scope refreshes to. */
export function isSessionScopedAction(action: UiAction): boolean {
  return action === "messages";
}
