import { useMemo, useState } from "react";
import {
  filterVisibleModels,
  groupByProvider,
  modelKey,
  toggleInList,
  toggleProviderModels,
} from "../lib/models";
import type { SettingKey } from "../../src/protocol";
import type { PickerModel } from "../lib/models";

interface Props {
  models: PickerModel[];
  hidden: string[];
  favorites: string[];
  defaultKey: string;
  recents: string[];
  onClose(): void;
  onUpdate(updates: Array<{ key: SettingKey; value: unknown }>): void;
}

type VisibilityFilter = "all" | "visible" | "hidden";

/**
 * Full-model management surface: search, provider sections with visibility
 * toggles, favorites, and default selection. Every mutation round-trips
 * through settings so the host stays the single source of truth.
 */
export function ModelManager(props: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<VisibilityFilter>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = props.models;
    if (q) {
      list = list.filter(
        (m) =>
          (m.name ?? m.id).toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.providerID.toLowerCase().includes(q),
      );
    }
    if (filter === "visible") list = filterVisibleModels(list, props.hidden);
    else if (filter === "hidden") {
      const keys = new Set(props.hidden);
      list = list.filter((m) => keys.has(modelKey(m)));
    }
    return groupByProvider(list);
  }, [props.models, props.hidden, props.recents.length, query, filter]);

  return (
    <div className="drawer">
      <div className="drawer-head">
        <input
          className="search"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <select
          className="filter-select"
          value={filter}
          onChange={(e) => setFilter(e.target.value as VisibilityFilter)}
          title="Filter by visibility"
        >
          <option value="all">all</option>
          <option value="visible">visible</option>
          <option value="hidden">hidden</option>
        </select>
        <button type="button" onClick={props.onClose}>
          done
        </button>
      </div>

      {props.recents.length > 0 && (
        <div className="recents">
          <span className="micro">recent:</span>
          {props.recents.map((key) => {
            const found = props.models.find((m) => modelKey(m) === key);
            return found ? (
              <button
                key={key}
                type="button"
                className="chip"
                title={key}
                onClick={() => setQuery(found.name ?? "")}
              >
                {found.name}
              </button>
            ) : null;
          })}
        </div>
      )}

      <div className="drawer-list">
        {filtered.length === 0 && (
          <div className="drawer-empty">No matching models.</div>
        )}
        {filtered.map((group) => {
          const fullProviderModels = props.models.filter(
            (m) => m.providerID === group.providerID,
          );
          const allKeys = fullProviderModels.map(modelKey);
          const allHidden = allKeys.every((k) => props.hidden.includes(k));
          return (
            <section key={group.providerID} className="prov-section">
              <header className="prov-head">
                <span className="prov-name">{group.providerID}</span>
                <span className="prov-count">{group.models.length}</span>
                <button
                  type="button"
                  className={`chip${allHidden ? "" : " on"}`}
                  title={
                    allHidden
                      ? "Show all from this provider"
                      : "Hide all from this provider"
                  }
                  onClick={() =>
                    props.onUpdate([
                      {
                        key: "models.hidden",
                        value: toggleProviderModels(
                          props.hidden,
                          group.providerID,
                          fullProviderModels,
                        ),
                      },
                    ])
                  }
                >
                  {allHidden ? "show all" : "hide all"}
                </button>
              </header>
              {group.models.map((m) => {
                const key = modelKey(m);
                const isHidden = props.hidden.includes(key);
                const isFav = props.favorites.includes(key);
                const isDefault = props.defaultKey === key;
                return (
                  <div
                    key={key}
                    className={`model-row${isHidden ? " dim" : ""}`}
                  >
                    <button
                      type="button"
                      className={`rowicon star${isFav ? " on" : ""}`}
                      title={isFav ? "Unstar" : "Star (pin to picker top)"}
                      onClick={() =>
                        props.onUpdate([
                          {
                            key: "models.favorites",
                            value: toggleInList(props.favorites, key),
                          },
                        ])
                      }
                    >
                      {isFav ? "★" : "☆"}
                    </button>
                    <span className="model-name">{m.name}</span>
                    <span className="model-meta">
                      {m.context ? `${Math.round(m.context / 1000)}k` : ""}
                    </span>
                    <button
                      type="button"
                      className={`rowicon${isDefault ? " on" : ""}`}
                      title={
                        isDefault
                          ? "Default for new sessions — click to clear"
                          : "Set as default for new sessions"
                      }
                      onClick={() =>
                        props.onUpdate([
                          {
                            key: "models.default",
                            value: isDefault ? "" : key,
                          },
                        ])
                      }
                    >
                      {isDefault ? "◉" : "○"}
                    </button>
                    <button
                      type="button"
                      className={`rowicon eye${isHidden ? " off" : ""}`}
                      title={isHidden ? "Show in picker" : "Hide from picker"}
                      onClick={() =>
                        props.onUpdate([
                          {
                            key: "models.hidden",
                            value: toggleInList(props.hidden, key),
                          },
                        ])
                      }
                    >
                      {isHidden ? "🚫" : "👁"}
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
