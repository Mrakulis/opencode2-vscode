import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { filterVisibleModels, groupByProvider, modelKey } from "../lib/models";
import { truncate } from "../lib/format";
import type { PickerModel } from "../lib/models";

interface Props {
  disabled: boolean;
  busy: boolean;
  sendKey: "enter" | "ctrlEnter";
  onSend(text: string): Promise<void> | void;
  onStop(): void;
  // selectors moved here from header
  agents: Array<{ id: string; name: string }>;
  activeAgent?: string;
  agentName?: string;
  models: Array<{ id: string; providerID: string; name?: string; context?: number; variants?: Array<{ id: string }> }>;
  hidden: string[];
  favorites: string[];
  defaultKey: string;
  recents: string[];
  activeModel?: { id: string; providerID: string; variant?: string };
  onPickModel(m: { id: string; providerID: string }): Promise<void>;
  onPickVariant(variant: string): Promise<void>;
  onPickAgent(a: string): Promise<void>;
  onToggleFavorite(key: string): void;
  onOpenManager(): void;
}

export function Composer(props: Props) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<"agent" | "model" | "variant" | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // auto-grow up to ~40vh
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent): void => {
      const target = e.target as Node;
      // don't close if clicking inside composer selectors
      const composer = document.querySelector(".composer-selectors");
      if (composer?.contains(target)) return;
      // use menuRef for precise check if available
      if (menuRef.current?.contains(target)) return;
      setMenu(undefined);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(undefined);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || props.busy) return;
    setText("");
    setPreview(false);
    try {
      await props.onSend(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setError(undefined), 4000);
    }
  }, [text, props]);

  // derived for selectors
  const visibleModels = useMemo(() => filterVisibleModels(props.models, props.hidden), [props.models, props.hidden]);
  const groups = useMemo(() => groupByProvider(visibleModels), [visibleModels]);
  const favoriteRows = useMemo(() => {
    const byKey = new Map(props.models.map((m) => [modelKey(m), m] as const));
    return props.favorites.map((k) => byKey.get(k)).filter((m): m is PickerModel => Boolean(m));
  }, [props.models, props.favorites]);
  const recentRows = useMemo(() => {
    const favSet = new Set(props.favorites);
    const byKey = new Map(visibleModels.map((m) => [modelKey(m), m] as const));
    return props.recents
      .filter((k) => !favSet.has(k))
      .map((k) => byKey.get(k))
      .filter((m): m is PickerModel => Boolean(m))
      .slice(0, 4);
  }, [visibleModels, props.recents, props.favorites]);

  const activeModelLabel = props.activeModel
    ? (props.models.find((m) => m.id === props.activeModel?.id && m.providerID === props.activeModel?.providerID)?.name ??
      props.activeModel.id)
    : "Model";

  const activeVariantLabel = props.activeModel?.variant ?? "Default";
  const activeModelVariants = useMemo(() => {
    const m = props.models.find((x) => x.id === props.activeModel?.id && x.providerID === props.activeModel?.providerID);
    return m?.variants ?? [];
  }, [props.models, props.activeModel]);

  const renderModelRow = (m: PickerModel, opts?: { compact?: boolean }) => (
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
      {props.defaultKey === modelKey(m) && <span className="row-default" title="default">◉</span>}
      <span
        role="button"
        tabIndex={0}
        className={`row-star${props.favorites.includes(modelKey(m)) ? " on" : ""}`}
        title={props.favorites.includes(modelKey(m)) ? "Unstar" : "Star"}
        aria-label={props.favorites.includes(modelKey(m)) ? "Unstar" : "Star"}
        onClick={(e) => { e.stopPropagation(); props.onToggleFavorite(modelKey(m)); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            props.onToggleFavorite(modelKey(m));
          }
        }}
      >
        {props.favorites.includes(modelKey(m)) ? "★" : "☆"}
      </span>
    </button>
  );

  return (
    <div className="composer">
      {error && <div className="composer-error">{error}</div>}

      <div className="composer-input-wrap">
        <textarea
          ref={ref}
          rows={1}
          placeholder={props.disabled ? "Connect to start a session…" : props.busy ? "Agent working…" : "Ask anything..."}
          disabled={props.disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              const allowed = props.sendKey === "enter" || e.ctrlKey || e.metaKey;
              if (!allowed) return;
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-input-actions">
          <button type="button" className="iconbtn" title="Attach" disabled>＋</button>
          <button
            type="button"
            className={`sendbtn${!text.trim() || props.disabled ? " disabled" : ""}`}
            disabled={props.disabled || !text.trim()}
            onClick={() => void submit()}
            title="Send"
          >
            ↑
          </button>
        </div>
      </div>

      <div className="composer-selectors" ref={menuRef}>
        {/* Agent / Plan */}
        <div className="picker">
          <button
            type="button"
            className="selector"
            title={props.agentName ?? props.activeAgent ?? "Plan"}
            onClick={() => setMenu(menu === "agent" ? undefined : "agent")}
          >
            <span className="selector-label">{props.agentName ?? props.activeAgent ?? "Plan"}</span>{" "}
            <span className="chevron">▾</span>
          </button>
          {menu === "agent" && (
            <div className="menu">
              {props.agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`menu-item${props.activeAgent === a.id ? " selected" : ""}`}
                  onClick={() => { setMenu(undefined); void props.onPickAgent(a.id); }}
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Model */}
        <div className="picker picker-model">
          <button type="button" className="selector" title={activeModelLabel} onClick={() => setMenu(menu === "model" ? undefined : "model")}>
            <span className="selector-label">{activeModelLabel}</span> <span className="chevron">▾</span>
          </button>
          {menu === "model" && (
            <div className="menu">
              {favoriteRows.length > 0 && (
                <>
                  <div className="menu-section">★ favorites</div>
                  {favoriteRows.map((m) => renderModelRow(m))}
                  <div className="menu-sep" />
                </>
              )}
              {recentRows.length > 0 && (
                <>
                  <div className="menu-section">recent</div>
                  {recentRows.map((m) => renderModelRow(m, { compact: true }))}
                  <div className="menu-sep" />
                </>
              )}
              {groups.map((g) => (
                <div key={g.providerID}>
                  <div className="menu-section">{g.providerID}</div>
                  {g.models.map((m) => renderModelRow(m))}
                </div>
              ))}
              <div className="menu-sep" />
              <button type="button" className="menu-item manage" onClick={() => { setMenu(undefined); props.onOpenManager(); }}>
                ⚙ Manage models…
              </button>
            </div>
          )}
        </div>

        {/* Thinking level / Variant */}
        <div className="picker">
          <button
            type="button"
            className="selector"
            onClick={() => setMenu(menu === "variant" ? undefined : "variant")}
            title={activeModelVariants.length === 0 ? `No variants for this model — ${activeVariantLabel}` : activeVariantLabel}
          >
            <span className="selector-label">{activeVariantLabel}</span> <span className="chevron">▾</span>
          </button>
          {menu === "variant" && (
            <div className="menu">
              <button
                type="button"
                className={`menu-item${!props.activeModel?.variant ? " selected" : ""}`}
                onClick={() => { setMenu(undefined); void props.onPickVariant(""); }}
              >
                Default
              </button>
              {activeModelVariants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`menu-item${props.activeModel?.variant === v.id ? " selected" : ""}`}
                  onClick={() => { setMenu(undefined); void props.onPickVariant(v.id); }}
                >
                  {v.id}
                </button>
              ))}
              {activeModelVariants.length === 0 && (
                <div className="menu-empty">No thinking levels for this model</div>
              )}
            </div>
          )}
        </div>

        <span className="spacer" />

        <div className="composer-actions-right">
          <button
            type="button"
            className={`chip${preview ? " on" : ""}`}
            title="Toggle markdown preview"
            onClick={() => setPreview((v) => !v)}
            disabled={!text.trim()}
          >
            preview
          </button>
          {props.busy ? (
            <button type="button" className="primary stop" onClick={props.onStop} title="Interrupt">
              ■ stop
            </button>
          ) : null}
        </div>
      </div>

      {preview && (
        <div className="md preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      )}
    </div>
  );
}
