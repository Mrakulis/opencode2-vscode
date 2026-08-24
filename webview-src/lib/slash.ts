/**
 * Pure helpers for the composer slash/`@` popovers.
 * Kept free of vscode/webview globals so they stay unit-testable under node.
 */

export interface SlashEntry {
  kind: "command" | "skill";
  name: string;
  description?: string;
  /** Local GUI action (no server round-trip) — run() executes it. */
  local?: boolean;
  run?: () => void;
}

export type SlashKind = "all" | "command" | "skill" | "gui";

/** Filter/sort slash entries by free-text query and entry kind. */
export function filterSlashEntries(
  entries: SlashEntry[],
  query: string,
  kind: SlashKind = "all",
): SlashEntry[] {
  const q = query.trim().toLowerCase();
  let rows =
    q.length === 0
      ? entries
      : entries.filter((e) => e.name.toLowerCase().includes(q));
  if (kind === "gui") rows = rows.filter((e) => e.local === true);
  else if (kind !== "all")
    rows = rows.filter((e) => e.kind === kind && e.local !== true);
  return rows.slice(0, 40);
}
