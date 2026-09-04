/** Pure model-picker helpers — no DOM/RPC dependencies, unit-testable. */

export interface PickerModel {
  id: string;
  providerID: string;
  name?: string;
  context?: number;
}

export function modelKey(m: Pick<PickerModel, "id" | "providerID">): string {
  return `${m.providerID}/${m.id}`;
}

export function parseModelKey(
  key: string,
): { providerID: string; id: string } | undefined {
  const idx = key.indexOf("/");
  if (idx <= 0 || idx === key.length - 1) return undefined;
  return { providerID: key.slice(0, idx), id: key.slice(idx + 1) };
}

export function filterVisibleModels<T extends PickerModel>(
  models: T[],
  hidden: string[],
): T[] {
  const set = new Set(hidden);
  return models.filter((m) => !set.has(modelKey(m)));
}

function providerRank(id: string): number {
  const lower = id.toLowerCase();
  // "opencode" is the Zen free tier — match exact known Zen ids only, so
  // unrelated providers merely containing "zen" (frozen, citizen) don't
  // steal top priority.
  if (lower === "opencode" || lower === "opencode-zen") return 0;
  if (lower === "opencode-go") return 1;
  return 2;
}

export function groupByProvider<T extends PickerModel>(
  models: T[],
): Array<{ providerID: string; models: T[] }> {
  const map = new Map<string, T[]>();
  for (const m of models) {
    const list = map.get(m.providerID);
    if (list) list.push(m);
    else map.set(m.providerID, [m]);
  }
  return [...map.entries()]
    .map(([providerID, grouped]) => ({
      providerID,
      models: [...grouped].sort((a, b) =>
        (a.name ?? a.id).localeCompare(b.name ?? b.id),
      ),
    }))
    .sort((a, b) => {
      const ra = providerRank(a.providerID);
      const rb = providerRank(b.providerID);
      if (ra !== rb) return ra - rb;
      return a.providerID.localeCompare(b.providerID);
    });
}

export function toggleInList(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

/**
 * Toggle an entire provider's visibility. If any of its models is currently
 * visible, hide all of them; otherwise reveal them all (removing their keys).
 */
export function toggleProviderModels(
  hidden: string[],
  providerID: string,
  models: PickerModel[],
): string[] {
  const keys = models.filter((m) => m.providerID === providerID).map(modelKey);
  const anyVisible = keys.some((k) => !hidden.includes(k));
  const set = new Set(hidden);
  for (const k of keys) {
    if (anyVisible) set.add(k);
    else set.delete(k);
  }
  return [...set];
}

/**
 * Model for a brand-new session, in priority order:
 *  1. last-used (client-tracked — config defaults are static by contract)
 *  2. explicit setting key ("provider/model")
 *  3. first enabled FREE OpenCode Zen model in the catalog (prefers
 *     "big-pickle") — guarantees a working binding instead of a possibly
 *     broken/unconfigured server default (P0: fresh sessions were unusable)
 *  4. server-reported default
 *
 * Every candidate is validated against the catalog when one is available;
 * a model that has left the catalog can no longer be bound to new sessions.
 * With an empty catalog (list fetch failed) validation is skipped so stale
 * behavior degrades gracefully instead of blocking session creation.
 */
export function resolveDefault(
  lastUsed: Pick<PickerModel, "id" | "providerID"> | undefined | null,
  settingKey: string,
  serverDefault: Pick<PickerModel, "id" | "providerID"> | undefined | null,
): { id: string; providerID: string } | undefined {
  if (lastUsed && lastUsed.id && lastUsed.providerID) {
    return { id: lastUsed.id, providerID: lastUsed.providerID };
  }
  if (settingKey.trim()) {
    const parsed = parseModelKey(settingKey.trim());
    if (parsed) return parsed;
  }
  if (serverDefault && serverDefault.id && serverDefault.providerID) {
    return { id: serverDefault.id, providerID: serverDefault.providerID };
  }
  return undefined;
}

/** Catalog row subset used for default-model validation/fallback. */
export interface DefaultCandidate {
  id: string;
  providerID: string;
}

/**
 * True when a catalog entry costs nothing to run. Cost shapes drift between
 * betas: models.dev uses `{input, output, ...}` while Zen rows have been seen
 * as `[{input, output, cache}]` — accept both.
 */
export function isFreeCatalogModel(
  m: Pick<DefaultCandidate, "id" | "providerID"> & { cost?: unknown },
): boolean {
  const zero = (v: unknown): boolean =>
    v === 0 || v === "0";
  const c = m.cost as
    | { input?: unknown; output?: unknown }
    | Array<{ input?: unknown; output?: unknown } | null | undefined>
    | undefined;
  if (!c) return false;
  const rows = Array.isArray(c) ? c : [c];
  return (
    rows.length > 0 &&
    rows.every((r) => zero(r?.input) && zero(r?.output))
  );
}

export interface CatalogRow extends DefaultCandidate {
  enabled?: boolean;
  cost?: unknown;
}

function inCatalog(
  ref: DefaultCandidate | undefined | null,
  catalog: CatalogRow[],
): boolean {
  if (!ref?.id || !ref.providerID) return false;
  if (catalog.length === 0) return true; // no catalog → don't block
  return catalog.some(
    (m) =>
      (m.enabled !== false &&
        m.providerID === ref!.providerID &&
        m.id === ref!.id),
  );
}

/**
 * Validated default for a NEW session. Order mirrors `resolveDefault`, plus
 * catalog validation and the free-Zen safety net before the server default.
 */
export function pickNewSessionModel(
  lastUsed: DefaultCandidate | undefined | null,
  settingKey: string,
  serverDefault: DefaultCandidate | undefined | null,
  catalog: CatalogRow[],
): { id: string; providerID: string } | undefined {
  // 1+2: user intent (validated only when we actually have a catalog)
  if (lastUsed && inCatalog(lastUsed, catalog)) return { ...lastUsed };
  if (settingKey.trim()) {
    const parsed = parseModelKey(settingKey.trim());
    if (parsed && inCatalog(parsed, catalog)) return parsed;
  }
  // 3: free Zen safety net — prefer big-pickle, then any enabled free Zen model.
  if (catalog.length > 0) {
    const zen = catalog.filter(
      (m) => m.enabled !== false && isFreeCatalogModel(m),
    );
    const pickle = zen.find((m) => m.providerID === "opencode" && m.id === "big-pickle");
    if (pickle) return { id: pickle.id, providerID: pickle.providerID };
    const firstZen = zen.find((m) => m.providerID === "opencode");
    if (firstZen) return { id: firstZen.id, providerID: firstZen.providerID };
    if (zen[0]) return { id: zen[0].id, providerID: zen[0].providerID };
  }
  // 4: server default, validated when possible.
  if (inCatalog(serverDefault, catalog) && serverDefault?.id && serverDefault?.providerID) {
    return { id: serverDefault.id, providerID: serverDefault.providerID };
  }
  // Catalog present but nothing usable — fall back to unvalidated resolution
  // rather than blocking session creation entirely.
  return resolveDefault(lastUsed, settingKey, serverDefault);
}
