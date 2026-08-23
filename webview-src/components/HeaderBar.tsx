import { useEffect, useRef, useState } from "react";
import { truncate } from "../lib/format";

interface Props {
  conn: "connected" | "connecting" | "error";
  title?: string;
  sessionId?: string;
  workspaceName?: string;
  drawerOpen: boolean;
  onToggleDrawer(): void;
  onRename(title: string): Promise<void>;
  onCopyTranscript(): Promise<void>;
  onFork(): Promise<void>;
  onCompact(): Promise<void>;
  onOpenManager(): void;
  onOpenProviders(): void;
  onOpenMcp(): void;
  onOpenSettings(): void;
  theme: "dark" | "light";
  onToggleTheme(): void;
}

export function HeaderBar(props: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
        <button type="button" className="iconbtn" title="Settings" onClick={props.onOpenSettings} style={{ fontSize: "14px", padding: "0 4px" }}>
          ⚙
        </button>
        <div className="picker">
          <button type="button" className="chip" onClick={() => setMenuOpen((v) => !v)}>
            ⋯ ▾
          </button>
          {menuOpen && (
            <div className="menu">
              <button type="button" className="menu-item manage" onClick={() => { setMenuOpen(false); props.onOpenManager(); }}>
                ⚙ Manage models…
              </button>
              <button type="button" className="menu-item manage" onClick={() => { setMenuOpen(false); props.onOpenProviders(); }}>
                Providers…
              </button>
              <button type="button" className="menu-item manage" onClick={() => { setMenuOpen(false); props.onOpenMcp(); }}>
                MCP servers…
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item"
                onClick={() => { props.onToggleTheme(); }}
                title="Switch between the OpenCode 2 dark and light themes"
              >
                {props.theme === "dark" ? "☾ Dark theme" : "☀ Light theme"}
              </button>
              <div className="menu-sep" />
              <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); void props.onCopyTranscript(); }}>
                Copy transcript
              </button>
              <button type="button" className="menu-item" disabled={!props.sessionId} onClick={() => { setMenuOpen(false); void props.onFork(); }}>
                Fork session
              </button>
              <button type="button" className="menu-item" disabled={!props.sessionId} onClick={() => { setMenuOpen(false); void props.onCompact(); }}>
                Compact now
              </button>
            </div>
          )}
        </div>

        <span className={`conn conn-${props.conn}`}>
          {props.conn === "connected" ? "live" : props.conn === "connecting" ? "linking" : "offline"}
        </span>
      </div>
    </header>
  );
}
