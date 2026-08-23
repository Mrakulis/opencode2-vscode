/**
 * Pure helpers for the composer slash/`@` popovers.
 * Kept free of vscode/webview globals so they stay unit-testable under node.
 */

export interface SlashEntry {
  kind: "command" | "skill";
  name: string;
  description?: string;
}

/** Filter/sort slash entries for the composer popover. */
export function filterSlashEntries(entries: SlashEntry[], query: string): SlashEntry[] {
  const q = query.trim().toLowerCase();
  const rows = q.length === 0 ? entries : entries.filter((e) => e.name.toLowerCase().includes(q));
  return rows.slice(0, 40);
}
