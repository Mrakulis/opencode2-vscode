/**
 * Date-range helpers for the Usage drawer period filter.
 * Pure functions, no DOM/RPC dependencies, unit-testable.
 */

export type UsagePeriod = "7d" | "30d" | "mtd" | "all" | "custom";

export interface Range {
  from?: number;
  to?: number;
}

/** IANA timezone for the server's `session.stats` bucketing. */
export function getLocalTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === "string" && tz.length > 0) return tz;
  } catch {
    /* ignore */
  }
  return "UTC";
}

function startOfMonthLocal(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function periodToRange(
  period: UsagePeriod,
  custom: Range | undefined,
  now: number = Date.now(),
): Range {
  switch (period) {
    case "7d":
      return { from: now - 7 * 24 * 3600 * 1000, to: now };
    case "30d":
      return { from: now - 30 * 24 * 3600 * 1000, to: now };
    case "mtd":
      return { from: startOfMonthLocal(now), to: now };
    case "all":
      return {};
    case "custom":
      return custom ? { from: custom.from, to: custom.to } : {};
    default:
      return {};
  }
}

export function formatRange(range: Range | undefined, fallback = "All time"): string {
  if (!range || (range.from === undefined && range.to === undefined)) return fallback;
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  if (range.from !== undefined && range.to !== undefined) {
    return `${fmt(range.from)} – ${fmt(range.to)}`;
  }
  if (range.from !== undefined) return `From ${fmt(range.from)}`;
  if (range.to !== undefined) return `Until ${fmt(range.to)}`;
  return fallback;
}

export function dateInputValue(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDateInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value + "T00:00:00").getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** True when a session's timestamp falls inside the range (inclusive). */
export function inRange(time: number, range: Range | undefined): boolean {
  if (!range) return true;
  if (range.from !== undefined && time < range.from) return false;
  if (range.to !== undefined && time > range.to) return false;
  return true;
}
