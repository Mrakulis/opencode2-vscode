/** Pure formatting helpers — no DOM, unit-testable. */

export function formatCost(usd: number | undefined): string {
  if (usd === undefined || Number.isNaN(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Sum every component of a V2 TokenUsageInfo. */
export function totalTokens(tokens:
  | { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  | undefined): number | undefined {
  if (!tokens) return undefined;
  const { input, output, reasoning, cache } = tokens;
  const parts = [input, output, reasoning, cache.read, cache.write];
  if (parts.some((v) => typeof v !== "number" || Number.isNaN(v))) return undefined;
  return parts.reduce((a, b) => a + b, 0);
}

/** Context usage percent against a model context limit; null when unknown. */
export function contextPercent(
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined,
  contextLimit: number | undefined,
): number | null {
  if (!tokens || !contextLimit || contextLimit <= 0) return null;
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
  return Math.min(100, Math.round((total / contextLimit) * 100));
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString();
}

/** Split unified-diff-ish text into lines with a sign class for coloring. */
export function diffLines(text: string): Array<{ cls: "add" | "del" | "meta" | "ctx"; text: string }> {
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) return { cls: "meta" as const, text: line };
    if (line.startsWith("+")) return { cls: "add" as const, text: line };
    if (line.startsWith("-")) return { cls: "del" as const, text: line };
    return { cls: "ctx" as const, text: line };
  });
}

/** Extract a human title for a tool card from its input/result. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const candidate =
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.command === "string" && input.command) ||
    (typeof input.url === "string" && input.url) ||
    (typeof input.pattern === "string" && input.pattern) ||
    (typeof input.query === "string" && input.query);
  const short = typeof candidate === "string" ? truncate(candidate.replace(/^.*[\\/]/, "") || candidate, 48) : "";
  return short ? `${name}: ${short}` : name;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
