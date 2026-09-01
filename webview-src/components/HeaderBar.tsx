import { useEffect, useRef, useState } from "react";
import { truncate } from "../lib/format";

interface Props {
  conn: "connected" | "connecting" | "error";
  title?: string;
  sessionId?: string;
  workspaceName?: string;
  branch?: string;
  /** Working-tree change counts for the branch chip badge. */
  vcsDiff?: { added: number; removed: number };
  drawerOpen: boolean;
  onToggleDrawer(): void;
  onRename(title: string): Promise<void>;
  onCopyTranscript(): Promise<void>;
  onFork(): Promise<void>;
  onCompact(): Promise<void>;
  /** Abandon a staged revert (session.revert.clear) when available. */
  onRevertClear?(): Promise<void> | void;
  onOpenInbox(): void;
  /** Opens the global usage/stats drawer (session-independent). */
  onOpenUsage(): void;
  onExport(): void;
  onImport(): void;
  onUndo(): void;
  onRedo(): void;
  onOpenWorkingDiff(): void;
  onOpenSavedPermissions(): void;
  onOpenInstructions(): void;
  onOpenWorktrees(): void;
  onOpenPlan(): void;
  onOpenManager(): void;
  onOpenProviders(): void;
  onOpenMcp(): void;
  onOpenCompanion(): void;
  onOpenSettings(): void;
  theme: string;
  onToggleTheme(id?: string): void;
  themes?: Array<{ id: string; label: string }>;
}

export function HeaderBar(props: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen && !themeMenuOpen) return;
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setThemeMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setThemeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, themeMenuOpen]);

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
          title="Click ✎ to rename (or double-click the title)"
          onDoubleClick={() => {
            setDraft(props.title ?? "");
            setRenaming(true);
          }}
        >
          {truncate(props.title ?? "New session", 34)}
          <button
            type="button"
            className="rename-pencil"
            title="Rename session"
            onClick={(e) => {
              e.stopPropagation();
              setDraft(props.title ?? "");
              setRenaming(true);
            }}
          >
            ✎
          </button>
        </span>
      )}
      {props.workspaceName && (
        <span className="ws-chip" title={props.workspaceName}>
          {truncate(props.workspaceName, 18)}
        </span>
      )}
      {props.branch && (
        <button
          type="button"
          className="ws-chip branch-chip"
          title={`Git branch: ${props.branch} — click to review working-tree changes`}
          onClick={props.onOpenWorkingDiff}
        >
          ⑂ {truncate(props.branch, 16)}
          {props.vcsDiff && props.vcsDiff.added + props.vcsDiff.removed > 0 && (
            <span className="branch-diff">
              {props.vcsDiff.added > 0 && (
                <span className="add">+{props.vcsDiff.added}</span>
              )}
              {props.vcsDiff.removed > 0 && (
                <span className="del">−{props.vcsDiff.removed}</span>
              )}
            </span>
          )}
        </button>
      )}

      <div className="header-right" ref={menuRef}>
        <button
          type="button"
          className="iconbtn"
          title="Settings"
          onClick={props.onOpenSettings}
          style={{ fontSize: "14px", padding: "0 4px" }}
        >
          ⚙
        </button>
        <div className="picker">
          <button
            type="button"
            className="chip"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯ ▾
          </button>
          {menuOpen && (
            <div className="menu">
              <div className="menu-section">session</div>
              <button
                type="button"
                className="menu-item"
                disabled={!props.sessionId}
                onClick={() => {
                  setMenuOpen(false);
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
                  setMenuOpen(false);
                  void props.onFork();
                }}
              >
                Fork session
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  void props.onRevertClear?.();
                }}
                disabled={!props.sessionId || !props.onRevertClear}
              >
                Abandon staged changes
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!props.sessionId}
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenInbox();
                }}
              >
                Inbox…
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenUsage();
                }}
                title="Tokens, cost, streaks and tool reliability"
              >
                Usage…
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!props.sessionId}
                onClick={() => {
                  setMenuOpen(false);
                  void props.onCompact();
                }}
              >
                Compact now
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!props.sessionId}
                onClick={() => {
                  setMenuOpen(false);
                  props.onUndo();
                }}
                title="Undo the last turn and revert its file changes"
              >
                ↶ Undo last turn
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!props.sessionId}
                onClick={() => {
                  setMenuOpen(false);
                  props.onRedo();
                }}
              >
                ↷ Redo
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!props.sessionId}
                onClick={() => {
                  setMenuOpen(false);
                  props.onExport();
                }}
              >
                ⤓ Export session…
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  props.onImport();
                }}
              >
                ⤒ Import session…
              </button>

              <div className="menu-section">code</div>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenWorkingDiff();
                }}
                title="Show the current working-tree diff from OpenCode VCS"
              >
                ↔ Working diff
              </button>
              <button
                type="button"
                className="menu-item manage"
                disabled={!props.sessionId}
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenInstructions();
                }}
              >
                Instructions…
              </button>
              <button
                type="button"
                className="menu-item manage"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenWorktrees();
                }}
              >
                Worktrees…
              </button>
              <button
                type="button"
                className="menu-item manage"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenPlan();
                }}
                title="Interactive checklist for implementation_plan.md (bespoke, local file)"
              >
                Plan checklist…
              </button>

              <div className="menu-section">configure</div>
              <button
                type="button"
                className="menu-item manage"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenManager();
                }}
              >
                Models…
              </button>
              <button
                type="button"
                className="menu-item manage"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenProviders();
                }}
              >
                Providers…
              </button>
              <button
                type="button"
                className="menu-item manage"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenMcp();
                }}
              >
                MCP servers…
              </button>
              <button
                type="button"
                className="menu-item manage"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenCompanion();
                }}
                title="Start companion server — set IP/port and get the app link"
              >
                Companion server…
              </button>
              <button
                type="button"
                className="menu-item manage"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenSavedPermissions();
                }}
              >
                Saved permissions…
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item manage"
                onClick={() => setThemeMenuOpen((v) => !v)}
                title="Switch between the OpenCode 2 themes and presets"
              >
                {props.theme === "dark"
                  ? "☾ Theme"
                  : props.theme === "light"
                    ? "☀ Theme"
                    : `◈ Theme — ${props.theme}`}{" "}
                ▸
              </button>
              {themeMenuOpen && (
                <div className="oc2-theme-sub">
                  {(props.themes ?? []).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`menu-item${props.theme === t.id ? " selected" : ""}`}
                      onClick={() => {
                        props.onToggleTheme(t.id);
                        setThemeMenuOpen(false);
                        setMenuOpen(false);
                      }}
                    >
                      {props.theme === t.id ? "● " : "○ "}
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  props.onToggleTheme();
                }}
                title="Cycle to the next theme"
              >
                ↻ Cycle theme
              </button>
              <div className="menu-sep" />
            </div>
          )}
        </div>

        <span className={`conn conn-${props.conn}`}>
          {props.conn === "connected"
            ? "live"
            : props.conn === "connecting"
              ? "linking"
              : "offline"}
        </span>
      </div>
    </header>
  );
}
