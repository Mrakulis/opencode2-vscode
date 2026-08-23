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

export function parseModelKey(key: string): { providerID: string; id: string } | undefined {
  const idx = key.indexOf("/");
  if (idx <= 0 || idx === key.length - 1) return undefined;
  return { providerID: key.slice(0, idx), id: key.slice(idx + 1) };
}

export function filterVisibleModels<T extends PickerModel>(models: T[], hidden: string[]): T[] {
  const set = new Set(hidden);
  return models.filter((m) => !set.has(modelKey(m)));
}

export function groupByProvider<T extends PickerModel>(models: T[]): Array<{ providerID: string; models: T[] }> {
  const map = new Map<string, T[]>();
  for (const m of models) {
    const list = map.get(m.providerID);
    if (list) list.push(m);
    else map.set(m.providerID, [m]);
  }
  return [...map.entries()]
    .map(([providerID, grouped]) => ({
      providerID,
      models: [...grouped].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
    }))
    .sort((a, b) => a.providerID.localeCompare(b.providerID));
}

export function toggleInList(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

/**
 * Toggle an entire provider's visibility. If any of its models is currently
 * visible, hide all of them; otherwise reveal them all (removing their keys).
 */
export function toggleProviderModels(hidden: string[], providerID: string, models: PickerModel[]): string[] {
  const keys = models.filter((m) => m.providerID === providerID).map(modelKey);
  const anyVisible = keys.some((k) => !hidden.includes(k));
  const set = new Set(hidden);
  for (const k of keys) {
    if (anyVisible) set.add(k);
    else set.delete(k);
  }
  return [...set];
}

export function resolveDefault(
  settingKey: string,
  serverDefault: Pick<PickerModel, "id" | "providerID"> | undefined | null,
): { id: string; providerID: string } | undefined {
  if (settingKey.trim()) {
    const parsed = parseModelKey(settingKey.trim());
    if (parsed) return parsed;
  }
  if (serverDefault && serverDefault.id && serverDefault.providerID) {
    return { id: serverDefault.id, providerID: serverDefault.providerID };
  }
  return undefined;
}
