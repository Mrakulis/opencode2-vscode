/**
 * Pure unified-diff helpers for pre-apply previews — no `vscode` import so
 * they stay unit-testable under plain node.
 *
 * The V2 server ships proposed file changes with every edit permission
 * (permission.asked → metadata.files[] = {file, patch, additions, deletions,
 * status}, verified live 2026-08-26). These helpers reconstruct the proposed
 * content in memory so a native side-by-side diff can be shown BEFORE
 * anything touches disk.
 */

export interface WireFileDiff {
  file: string;
  patch: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

interface Hunk {
  origStart: number; // 1-based line number into the original
  lines: Array<{ kind: " " | "-" | "+"; text: string }>;
}

/** Parse unified-diff hunks; tolerant of Index/---/+++ preambles. */
export function parseHunks(patch: string): Hunk[] {
  const rows = patch.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const row of rows) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      current = { origStart: parseInt(hunk[1]!, 10), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // preamble (Index:/===/---/+++) — ignored
    if (row.startsWith("\\")) continue; // "\ No newline at end of file"
    if (
      row.startsWith("diff ") ||
      row.startsWith("Index:") ||
      row.startsWith("===") ||
      row.startsWith("--- ") ||
      row.startsWith("+++ ")
    ) {
      continue;
    }
    const kind = row[0];
    if (kind === " " || kind === "-" || kind === "+") {
      current.lines.push({ kind, text: row.slice(1) });
    }
  }
  return hunks;
}

/**
 * Apply a unified patch to `original` in memory. Returns the proposed content,
 * or undefined when the context doesn't match (caller should fall back to a
 * plain patch view rather than showing something wrong).
 */
export function applyUnifiedPatch(
  original: string,
  patch: string,
): string | undefined {
  const hunks = parseHunks(patch);
  if (hunks.length === 0) return undefined;
  const origLines = original.length ? original.split(/\r?\n/) : [];
  const out: string[] = [];
  let cursor = 0; // 0-based index into origLines already consumed
  for (const hunk of hunks) {
    // Copy unchanged lines before this hunk. origStart 0 means "new file"
    // (@@ -0,0 …) — nothing to copy.
    const skip = hunk.origStart <= 0 ? 0 : hunk.origStart - 1 - cursor;
    if (skip < 0) return undefined; // overlapping/unordered hunks
    for (let i = 0; i < skip; i++) out.push(origLines[cursor + i]!);
    cursor += skip;
    // Apply the hunk: verify '-'/' ' rows match the original exactly.
    for (const line of hunk.lines) {
      if (line.kind === "+") {
        out.push(line.text);
        continue;
      }
      const orig = origLines[cursor];
      if (orig !== line.text) return undefined; // context mismatch
      cursor++;
      if (line.kind === " ") out.push(line.text);
    }
  }
  // Trailing unchanged lines after the last hunk.
  while (cursor < origLines.length) out.push(origLines[cursor++]!);
  return out.join("\n");
}

/** Content of an added file from its all-plus patch. */
export function extractAddedContent(patch: string): string | undefined {
  const rows = parseHunks(patch).flatMap((h) => h.lines);
  if (rows.length === 0) return undefined;
  return rows
    .filter((l) => l.kind === "+")
    .map((l) => l.text)
    .join("\n");
}
