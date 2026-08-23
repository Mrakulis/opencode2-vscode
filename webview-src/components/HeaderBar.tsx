import { useEffect, useMemo, useRef, useState } from "react";
import { filterVisibleModels, groupByProvider, modelKey } from "../lib/models";
import { truncate } from "../lib/format";
import type { PickerModel } from "../lib/models";

export interface ModelOption {
  id: string;
  providerID: string;
  name: string;
  context: number;
}

interface Props {
  conn: "connected" | "connecting" | "error";
  title?: string;
  sessionId?: string;
  workspaceName?: string;
  activeModel?: { id: string; providerID: string };
  activeAgent?: string;
  agentName?: string;
  /** Full catalog (visibility filtering happens here). */
  models: ModelOption[];
  agents: Array<{ id: string; name: string }>;
  hidden: string[];
  favorites: string[];
  defaultKey: string;
  recents: string[];
  drawerOpen: boolean;
  onToggleDrawer(): void;
  onRename(title: string): Promise<void>;
  onPickModel(m: { id: string; providerID: string }): Promise<void>;
  onToggleFavorite(key: string): void;
  onSetDefault(key: string): void;
  onCopyTranscript(): Promise<void>;
  onFork(): Promise<void>;
  onCompact(): Promise<void>;
  onToggleModelVisible(key: string): void;
  onOpenManager(): void;
  onOpenProviders(): void;
  onOpenMcp(): void;
  onPickAgent(a: string): Promise<void>;
}

const COLLAPSED_KEY = "opencode2.collapsedProviders";

function readCollapsed(): Set<string> {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set<string>();
  }
}

function writeCollapsed(set: Set<string>): void {
  sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
}

export function HeaderBar(props: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<"model" | "agent" | "overflow" | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(readCollapsed);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(undefined);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const visibleModels = useMemo(
    () => filterVisibleModels(props.models, props.hidden),
    [props.models, props.hidden],
  );
  const groups = useMemo(() => groupByProvider(visibleModels), [visibleModels]);
  const favoriteRows = useMemo(() => {
    const byKey = new Map(props.models.map((m) => [modelKey(m), m] as const));
    return props.favorites
      .map((k) => byKey.get(k))
      .filter((m): m is ModelOption => Boolean(m));
  }, [props.models, props.favorites]);
  const recentRows = useMemo(() => {
    const byKey = new Map(visibleModels.map((m) => [modelKey(m), m] as const));
    return props.recents
      .map((k) => byKey.get(k))
      .filter((m): m is ModelOption => Boolean(m))
      .slice(0, 4);
  }, [visibleModels, props.recents]);

  const activeLabel =
    props.activeModel
      ? (props.models.find((m) => m.id === props.activeModel?.id && m.providerID === props.activeModel?.providerID)?.name ??
        props.activeModel.id)
      : "model";

  const toggleCollapsed = (providerID: string): void => {
    const next = new Set(collapsedProviders);
    if (next.has(providerID)) next.delete(providerID);
    else next.add(providerID);
    setCollapsedProviders(next);
    writeCollapsed(next);
  };

  const renderRow = (m: PickerModel, opts?: { compact?: boolean }) => (
    <button
      key={modelKey(m)}
      type="button"
      className={`menu-item row${props.activeModel?.id === m.id && props.activeModel?.providerID === m.providerID ? " selected" : ""}`}
      title={`${m.name} · ${m.context ? `${Math.round(m.context / 1000)}k ctx` : ""} · ${modelKey(m)}`}
      onClick={() => {
        setMenu(undefined);
        void props.onPickModel({ id: m.id, providerID: m.providerID });
      }}
    >
      <span className="row-label">{opts?.compact ? truncate(m.name ?? m.id, 26) : (m.name ?? m.id)}</span>
      {props.defaultKey === modelKey(m) && (
        <span className="row-default" title="default for new sessions">
          ◉
        </span>
      )}
      <span
        className={`row-star${props.favorites.includes(modelKey(m)) ? " on" : ""}`}
        role="button"
        title={props.favorites.includes(modelKey(m)) ? "Unstar" : "Star"}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleFavorite(modelKey(m));
        }}
      >
        {props.favorites.includes(modelKey(m)) ? "★" : "☆"}
      </span>
    </button>
  );

  return (
    <header className="header">
      <button
        type="button"
        className={`iconbtn${props.drawerOpen ? " active" : ""}`}
        title="Sessions"
        onClick={props.onToggleDrawer}
      >
        ≡
      </button>

      {renaming ? (
        <input
          className="rename"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void props.onRename(draft.trim() || "Untitled");
              setRenaming(false);
            }
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={() => setRenaming(false)}
        />
      ) : (
        <span
          className="title"
          title="Double-click to rename"
          onDoubleClick={() => {
            setDraft(props.title ?? "");
            setRenaming(true);
          }}
        >
          {truncate(props.title ?? "New session", 34)}
        </span>
      )}
      {props.workspaceName && (
        <span className="ws-chip" title={props.workspaceName}>
          {truncate(props.workspaceName, 18)}
        </span>
      )}

      <div className="header-right" ref={menuRef}>
        <PickerButton label={activeLabel} open={menu === "model"} onToggle={() => setMenu(menu === "model" ? undefined : "model")}>
          {favoriteRows.length > 0 && (
            <>
              <div className="menu-section">★ favorites</div>
              {favoriteRows.map((m) => renderRow(m))}
              <div className="menu-sep" />
            </>
          )}
          {recentRows.length > 0 && (
            <>
              <div className="menu-section">recent</div>
              {recentRows.map((m) => renderRow(m, { compact: true }))}
              <div className="menu-sep" />
            </>
          )}
          {groups.map((g) => (
            <div key={g.providerID}>
              <div
                className="prov-head"
                onClick={() => toggleCollapsed(g.providerID)}
                role="presentation"
              >
                <span className={`chev${collapsedProviders.has(g.providerID) ? "" : " open"}`}>▸</span>
                <span className="prov-name">{g.providerID}</span>
                <span className="prov-count">{g.models.length}</span>
              </div>
              {!collapsedProviders.has(g.providerID) && g.models.map((m) => renderRow(m))}
            </div>
          ))}
          <button type="button" className="menu-item manage" onClick={() => { setMenu(undefined); props.onOpenManager(); }}>
            ⚙ Manage models…
          </button>
          <button type="button" className="menu-item manage" onClick={() => { setMenu(undefined); props.onOpenProviders(); }}>
            Providers…
          </button>
          <button type="button" className="menu-item manage" onClick={() => { setMenu(undefined); props.onOpenMcp(); }}>
            MCP servers…
          </button>
        </PickerButton>

        <PickerButton
          label={props.agentName ?? props.activeAgent ?? "agent"}
          open={menu === "agent"}
          onToggle={() => setMenu(menu === "agent" ? undefined : "agent")}
        >
          {props.agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`menu-item${props.activeAgent === a.id ? " selected" : ""}`}
              onClick={() => {
                setMenu(undefined);
                void props.onPickAgent(a.id);
              }}
            >
              {a.name}
            </button>
          ))}
        </PickerButton>

        <PickerButton label="⋯" open={menu === "overflow"} onToggle={() => setMenu(menu === "overflow" ? undefined : "overflow")}>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setMenu(undefined);
              void props.onCopyTranscript();
            }}
          >
            Copy transcript
          </button>
          <button
            type="button"
            className="menu-item"
            disabled={!props.sessionId}
            onClick={() => {
              setMenu(undefined);
              void props.onFork();
            }}
          >
            Fork session
          </button>
          <button
            type="button"
            className="menu-item"
            disabled={!props.sessionId}
            onClick={() => {
              setMenu(undefined);
              void props.onCompact();
            }}
          >
            Compact now
          </button>
        </PickerButton>

        <span className={`conn conn-${props.conn}`}>
          {props.conn === "connected" ? "live" : props.conn === "connecting" ? "linking" : "offline"}
        </span>
      </div>
    </header>
  );
}

function PickerButton({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle(): void;
  children: React.ReactNode;
}) {
  return (
    <div className="picker">
      <button type="button" className="chip" onClick={onToggle}>
        {label} ▾
      </button>
      {open && <div className="menu">{children}</div>}
    </div>
  );
}
