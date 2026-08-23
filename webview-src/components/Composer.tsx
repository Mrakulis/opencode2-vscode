import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { filterVisibleModels, groupByProvider, modelKey } from "../lib/models";
import { truncate } from "../lib/format";
import type { PickerModel } from "../lib/models";
import { rpc } from "../lib/rpc";

interface Props {
  disabled: boolean;
  busy: boolean;
  sendKey: "enter" | "ctrlEnter";
  onSend(text: string, files?: Array<{ uri: string; name?: string }>): Promise<void> | void;
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; preview: string; uri: string }>>([]);
  const [modelFilter, setModelFilter] = useState("");

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

  useEffect(() => {
    if (menu !== "model") setModelFilter("");
  }, [menu]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files as unknown as File[]);
    for (const file of list) {
      if (!file.type.startsWith("image/")) continue;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const preview = URL.createObjectURL(file);
      setAttachments((a) => [...a, { id, name: file.name || "pasted-image.png", preview, uri: "" }]);
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
        const b64 = btoa(binary);
        const res = await rpc.call<{ uri: string }>("image.save", { data: b64, name: file.name || "pasted-image.png", mime: file.type });
        setAttachments((a) => a.map((x) => (x.id === id ? { ...x, uri: res.uri } : x)));
      } catch {}
    }
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const submit = useCallback(async () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || props.busy) return;
    const files = attachments.filter((a) => a.uri).map((a) => ({ uri: a.uri, name: a.name }));
    setText("");
    setAttachments((a) => {
      a.forEach((x) => URL.revokeObjectURL(x.preview));
      return [];
    });
    setPreview(false);
    try {
      await props.onSend(value, files.length ? files : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setError(undefined), 4000);
    }
  }, [text, attachments, props]);

  // derived for selectors
  const visibleModels = useMemo(() => filterVisibleModels(props.models, props.hidden), [props.models, props.hidden]);
  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    if (!q) return visibleModels;
    return visibleModels.filter(
      (m) => m.providerID.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
    );
  }, [visibleModels, modelFilter]);
  const groups = useMemo(() => groupByProvider(filteredModels), [filteredModels]);
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

  const activeModelVariants = useMemo(() => {
    const m = props.models.find((x) => x.id === props.activeModel?.id && x.providerID === props.activeModel?.providerID);
    // filter out synthetic "none" variant — it maps to Default (no reasoning)
    const all = m?.variants ?? [];
    return all.filter((v) => v.id !== "none");
  }, [props.models, props.activeModel]);
  const defaultVariantId = useMemo(() => {
    if (activeModelVariants.length === 0) return undefined;
    const ids = activeModelVariants.map((v) => v.id);
    for (const cand of ["high", "medium", "low", "xhigh", "minimal", "max"]) if (ids.includes(cand)) return cand;
    return ids[0];
  }, [activeModelVariants]);
  const activeVariantLabel = props.activeModel?.variant ?? (defaultVariantId ? `Default (${defaultVariantId})` : "Default");
  const activeModelContext = useMemo(() => {
    const m = props.models.find((x) => x.id === props.activeModel?.id && x.providerID === props.activeModel?.providerID);
    return (m as unknown as { context?: number; limit?: { context?: number } })?.context ??
      (m as unknown as { limit?: { context?: number } })?.limit?.context;
  }, [props.models, props.activeModel]);
  const hasVariants = activeModelVariants.length > 0;

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

      <div
        className="composer-input-wrap"
        onDragOver={(e) => {
          if ([...Array.from(e.dataTransfer.types)].includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
        }}
      >
        <textarea
          ref={ref}
          rows={1}
          placeholder={props.disabled ? "Connect to start a session…" : props.busy ? "Agent working…" : "Ask anything..."}
          disabled={props.disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
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
          <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.currentTarget.value = ""; }} />
          <button type="button" className="iconbtn" title="Attach image" disabled={props.disabled} onClick={() => fileInputRef.current?.click()}>
            ＋
          </button>
          <button
            type="button"
            className={`sendbtn${(!text.trim() && attachments.length === 0) || props.disabled ? " disabled" : ""}`}
            disabled={props.disabled || (!text.trim() && attachments.length === 0)}
            onClick={() => void submit()}
            title="Send"
          >
            ↑
          </button>
        </div>
      </div>
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <div key={a.id} className="attachment">
              <img src={a.preview} alt={a.name} />
              <button
                type="button"
                className="attachment-remove"
                onClick={() => {
                  URL.revokeObjectURL(a.preview);
                  setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                }}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

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
            <div className="menu" style={{ minWidth: "280px" }}>
              <input
                className="filter"
                placeholder="Search models..."
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <div className="menu-sep" />
              {!modelFilter.trim() && favoriteRows.length > 0 && (
                <>
                  <div className="menu-section">★ favorites</div>
                  {favoriteRows.map((m) => renderModelRow(m))}
                  <div className="menu-sep" />
                </>
              )}
              {!modelFilter.trim() && recentRows.length > 0 && (
                <>
                  <div className="menu-section">recent</div>
                  {recentRows.map((m) => renderModelRow(m, { compact: true }))}
                  <div className="menu-sep" />
                </>
              )}
              {groups.length === 0 ? (
                <div className="menu-empty">No matching models</div>
              ) : (
                groups.map((g) => (
                  <div key={g.providerID}>
                    <div className="menu-section">{g.providerID}</div>
                    {g.models.map((m) => renderModelRow(m))}
                  </div>
                ))
              )}
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
            title={
              !hasVariants
                ? `No reasoning levels — model ${activeModelLabel} does not expose variants${activeModelContext ? ` (context ${Math.round(activeModelContext / 1000)}k)` : ""}`
                : `${activeVariantLabel}${activeModelContext ? ` · ${Math.round(activeModelContext / 1000)}k ctx` : ""}`
            }
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
                Default{defaultVariantId ? ` (${defaultVariantId})` : ""}
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
