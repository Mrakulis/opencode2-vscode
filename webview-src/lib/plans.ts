/**
 * implementation_plan.md checklist parser — purely bespoke feature (the V2
 * API has no plan/task endpoints; this is local-file only). Pure functions,
 * no DOM/RPC dependencies, unit-testable.
 */

export type TaskStatus = "open" | "done" | "inprogress";

export interface PlanTask {
  /** 0-based line index in the markdown source. */
  line: number;
  title: string;
  status: TaskStatus;
}

const RE = /^(\s*[-*]\s+)\[( |x|\/|X)\](\s+)(.*)$/i;

/** Parse every task item out of a markdown document. */
export function parsePlanTasks(markdown: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const rows = markdown.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const m = RE.exec(rows[i]!);
    if (!m) continue;
    const box = m[2]!.toLowerCase();
    tasks.push({
      line: i,
      title: m[4]!.trim(),
      status: box === "x" ? "done" : box === "/" ? "inprogress" : "open",
    });
  }
  return tasks;
}

/**
 * Rewrite one task's checkbox in the original markdown, preserving all other
 * lines byte-for-byte (line endings normalized per row join).
 */
export function setTaskStatus(
  markdown: string,
  line: number,
  status: TaskStatus,
): string {
  const rows = markdown.split(/\r?\n/);
  const target = rows[line];
  if (target === undefined) return markdown;
  const m = RE.exec(target);
  if (!m) return markdown;
  const box = status === "done" ? "x" : status === "inprogress" ? "/" : " ";
  rows[line] = `${m[1]}[${box}]${m[3]}${m[4]}`;
  return rows.join("\n");
}

/** First non-done task (in progress preferred), for “Run next task”. */
export function nextTask(tasks: PlanTask[]): PlanTask | undefined {
  return (
    tasks.find((t) => t.status === "inprogress") ??
    tasks.find((t) => t.status === "open")
  );
}
