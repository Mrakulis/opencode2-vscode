/**
 * Synthesize a unified-style diff for edit/write tool calls.
 *
 * V2 edit tools return {path, oldString, newString} and write tools
 * {path, content} — usually WITHOUT a diff in their result content. This
 * builds the missing diff so the feed can show what actually changed.
 * Pure + dependency-free (unit-testable).
 */

export const DIFF_MAX_LINES = 400;

/**
 * Diff of replacing `oldText` with `newText`: common leading/trailing lines
 * are trimmed so only the replaced middle shows as -/+ pairs.
 * Returns "" when there is no visible change.
 */
export function synthEditDiff(oldText: string, newText: string, maxLines = DIFF_MAX_LINES): string {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");

  // Pure insert / delete of whole content: skip the empty side entirely so a
  // blank string doesn't render as a phantom "-" or "+" line.
  if (!oldText) return synthWriteDiff(newText, maxLines);
  if (!newText) {
    const removed = a.map((l) => `-${l}`);
    return applyCap(removed, maxLines);
  }

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);

  const lines: string[] = [];
  for (const l of removed) lines.push(`-${l}`);
  for (const l of added) lines.push(`+${l}`);

  return lines.length === 0 ? "" : applyCap(lines, maxLines);
}

function applyCap(lines: string[], maxLines: number): string {
  if (lines.length === 0) return "";
  if (lines.length > maxLines) {
    return [...lines.slice(0, maxLines), `+ … (${lines.length - maxLines} more lines truncated)`].join("\n");
  }
  return lines.join("\n");
}

/** Full-file diff for `write` (create/overwrite): everything shows as added. */
export function synthWriteDiff(content: string, maxLines = DIFF_MAX_LINES): string {
  if (!content) return "";
  return applyCap(
    content.split("\n").map((l) => `+${l}`),
    maxLines,
  );
}
