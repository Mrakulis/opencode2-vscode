import { useEffect, useRef, useState } from "react";
import { isAssistant, isUser, type AnyMessage, type MessagePartText, type MessagePartReasoning, type MessagePartTool } from "../lib/rpc";
import { renderMarkdown } from "../lib/markdown";
import { diffLines, formatCost, formatTokens, toolTitle, truncate } from "../lib/format";
import { rpc } from "../lib/rpc";

export function Feed({
  messages,
  busy,
  showReasoning,
  expandShellTools,
  expandEditTools,
  fullShellOutput,
  messageStats,
}: {
  messages: AnyMessage[];
  busy: boolean;
  showReasoning: "hide" | "collapsed" | "expanded";
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
  messageStats: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Ensure chronological order: oldest at top, newest at bottom.
  const sortedMessages = [...messages].sort((a, b) => {
    const ta = (a as unknown as { time?: { created?: number } }).time?.created ?? 0;
    const tb = (b as unknown as { time?: { created?: number } }).time?.created ?? 0;
    if (ta === 0 && tb === 0) return 0;
    return ta - tb;
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setShowJump(!pinnedRef.current);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Follow output only while the user stays pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [sortedMessages]);

  if (sortedMessages.length === 0 && !busy) {
    return (
      <div className="feed-scroll" ref={scrollRef}>
        <div className="feed-empty">
          <div className="feed-empty-icon">✦</div>
          <div className="feed-empty-title">Start a conversation</div>
          <div className="feed-empty-hint">Ask anything about this workspace — explain a file, fix a bug, or plan a feature. Your context is the open folder.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="feed-scroll" ref={scrollRef}>
      {sortedMessages.map((m) => (
        <MessageGroup
          key={m.id}
          message={m}
          showReasoning={showReasoning}
          expandShellTools={expandShellTools}
          expandEditTools={expandEditTools}
          fullShellOutput={fullShellOutput}
          messageStats={messageStats}
        />
      ))}
      {busy && <div className="streaming-caret" aria-label="working" />}

      {showJump && (
        <button
          type="button"
          className="jump"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            pinnedRef.current = true;
            setShowJump(false);
          }}
        >
          ↓ latest
        </button>
      )}
    </div>
  );
}

function MessageGroup({
  message,
  showReasoning,
  expandShellTools,
  expandEditTools,
  fullShellOutput,
  messageStats,
}: {
  message: AnyMessage;
  showReasoning: "hide" | "collapsed" | "expanded";
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
  messageStats: boolean;
}) {
  if (isUser(message)) {
    return (
      <article className="msg user">
        <div className="bubble">{message.text}</div>
      </article>
    );
  }
  if (!isAssistant(message)) return null;

  return (
    <article className="msg assistant">
      <header className="msg-head">
        {message.agent} · {message.model?.id ?? ""}
      </header>
      {message.content?.map((part, i) => (
        <Part key={i} part={part} showReasoning={showReasoning} expandShellTools={expandShellTools} expandEditTools={expandEditTools} fullShellOutput={fullShellOutput} />
      ))}
      {messageStats && (message.cost !== undefined || message.tokens !== undefined) && (
        <footer className="msg-foot">
          {message.tokens && (
            <span title={`input ${message.tokens.input} · output ${message.tokens.output} · reasoning ${message.tokens.reasoning} · cache read ${message.tokens.cache.read} · cache write ${message.tokens.cache.write}`}>
              ↑{formatTokens(message.tokens.input)} ↓{formatTokens(message.tokens.output)}
              {message.tokens.reasoning > 0 ? ` ✻${formatTokens(message.tokens.reasoning)}` : ""}
            </span>
          )}
          {message.cost !== undefined && <span>{formatCost(message.cost)}</span>}
        </footer>
      )}
      {message.error != null && (
        <pre className="tool-error">{stringifyError(message.error)}</pre>
      )}
    </article>
  );
}

function handleFileClick(e: React.MouseEvent) {
  const target = e.target as HTMLElement;
  // 1) markdown links <a href="...">
  const anchor = target.closest("a") as HTMLAnchorElement | null;
  if (anchor) {
    const href = anchor.getAttribute("href");
    if (href && !/^(https?:|mailto:|vscode:)/.test(href)) {
      e.preventDefault();
      let p = href.replace(/^file:\/\//, "");
      try { p = decodeURIComponent(p); } catch {}
      void rpc.call("file.open", { path: p }).catch(() => undefined);
      return;
    }
  }
  // 2) inline <code> file paths like `src/foo.ts:12`
  const code = target.closest("code");
  if (code) {
    const txt = (code.textContent ?? "").trim();
    if (/^[\w\-./\\]+:\d+/.test(txt) || /^[\w\-./\\]+\.(ts|tsx|js|json|md|css|rs|py|go)\b/.test(txt)) {
      e.preventDefault();
      const m = txt.match(/^(.+?)(?::\d+.*)?$/);
      const p = m ? m[1] : txt;
      void rpc.call("file.open", { path: p }).catch(() => undefined);
    }
  }
}

function Part({
  part,
  showReasoning,
  expandShellTools,
  expandEditTools,
  fullShellOutput,
}: {
  part: MessagePartText | MessagePartReasoning | MessagePartTool;
  showReasoning: "hide" | "collapsed" | "expanded";
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
}) {
  if (part.type === "text") {
    return <div className="md" onClick={handleFileClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }} />;
  }
  if (part.type === "reasoning") {
    if (showReasoning === "hide") return null;
    return <Reasoning text={part.text} defaultOpen={showReasoning === "expanded"} />;
  }
  if (part.type === "tool") {
    return <ToolCard part={part} expandShellTools={expandShellTools} expandEditTools={expandEditTools} fullShellOutput={fullShellOutput} />;
  }
  return null;
}

function Reasoning({ text, defaultOpen }: { text: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  if (!text.trim()) return null;
  return (
    <details className="reasoning" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>thinking</summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

const SHELL_TOOLS = new Set(["bash", "shell", "terminal", "exec", "command", "powershell"]);
const EDIT_TOOLS = new Set(["edit", "write", "apply", "apply_patch", "multiedit", "patch", "create_file", "str_replace"]);
const READ_TOOLS = new Set(["read", "read_file", "view", "open", "grep", "search", "find", "glob", "glob_search", "list", "ls", "cat", "glob_files", "file_search"]);

function toolKind(name: string): "shell" | "edit" | "read" | "other" {
  const n = name.toLowerCase();
  if (/[/.]/.test(n) || SHELL_TOOLS.has(n)) return "shell";
  if (EDIT_TOOLS.has(n) || /edit|diff|patch/.test(n)) return "edit";
  if (READ_TOOLS.has(n) || /read|grep|find|glob|search|list/.test(n)) return "read";
  return "other";
}

function initiallyExpanded(toolName: string, shellPref: boolean, editPref: boolean): boolean {
  const n = toolName.toLowerCase();
  if (/[/.]/.test(n) || SHELL_TOOLS.has(n)) return shellPref;
  if (EDIT_TOOLS.has(n) || /edit|diff|patch/.test(n)) return editPref;
  return false;
}

type ToolPart = MessagePartTool;

function ToolCard({ part, expandShellTools, expandEditTools, fullShellOutput }: { part: ToolPart; expandShellTools: boolean; expandEditTools: boolean; fullShellOutput: boolean }) {
  const [expanded, setExpanded] = useState(() => initiallyExpanded(part.name, expandShellTools, expandEditTools));
  useEffect(() => setExpanded(initiallyExpanded(part.name, expandShellTools, expandEditTools)), [part.name, expandShellTools, expandEditTools]);
  const kind = toolKind(part.name);

  let title = part.name;
  let body: React.ReactNode = null;

  if (part.state.status === "completed") {
    // shell header should just say "shell" — command goes inside the body as terminal
    title = kind === "shell" ? "shell" : toolTitle(part.name, part.state.input ?? {});
    const shellCmd =
      kind === "shell" && typeof (part.state.input as Record<string, unknown> | undefined)?.command === "string"
        ? ((part.state.input as Record<string, unknown>).command as string)
        : typeof (part.state.input as Record<string, unknown> | undefined)?.cmd === "string"
          ? ((part.state.input as Record<string, unknown>).cmd as string)
          : undefined;
    body = (
      <>
        {kind === "shell" && shellCmd && <pre className="tool-cmd">{`$ ${shellCmd}`}</pre>}
        {part.state.content?.map((c, i) => {
          if (c.type === "text") {
            const txt = String(c.text);
            // Edit summary like "Edited webview-src/styles.css (1 replacement)" — file name opens the file
            if (kind === "edit" && txt.startsWith("Edited ")) {
              const m = txt.match(/Edited\s+([^\s(]+)/);
              const file = m?.[1];
              if (file) {
                const idx = txt.indexOf(file);
                return (
                  <pre key={i} className="tool-out" onClick={handleFileClick}>
                    {txt.slice(0, idx)}
                    <a
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void rpc.call("file.open", { path: file }).catch(() => undefined);
                      }}
                      style={{ color: "var(--oc2-link)", cursor: "pointer", textDecoration: "underline" }}
                      title="Open file"
                    >
                      {file}
                    </a>
                    {txt.slice(idx + file.length)}
                  </pre>
                );
              }
            }
            return (
              <pre key={i} className={`tool-out${kind === "shell" ? " terminal" : ""}${fullShellOutput ? " full" : ""}`} onClick={handleFileClick}>
                {fullShellOutput ? txt : truncate(txt, 4000)}
              </pre>
            );
          }
          const maybeDiff = (c as { diff?: unknown }).diff;
          if (typeof maybeDiff === "string") {
            const input = (part.state as { input?: Record<string, unknown> }).input;
            const fileHint =
              (typeof input === "object" &&
                input !== null &&
                (typeof input.filePath === "string"
                  ? (input.filePath as string)
                  : typeof input.path === "string"
                    ? (input.path as string)
                    : typeof input.file === "string"
                      ? (input.file as string)
                      : undefined)) || "edit.diff";
            return (
              <div key={i}>
                <pre className="diff">
                  {diffLines(maybeDiff).map((l, j) => (
                    <span key={j} className={`line ${l.cls}`}>
                      {l.text}
                      {"\n"}
                    </span>
                  ))}
                </pre>
                <button
                  type="button"
                  className="chip"
                  style={{ marginTop: "6px" }}
                  onClick={() => void rpc.call("diff.open", { file: fileHint, diff: maybeDiff }).catch(() => undefined)}
                  title="Open diff in editor"
                >
                  ↔ Open diff
                </button>
                <button
                  type="button"
                  className="chip"
                  style={{ marginLeft: "6px" }}
                  onClick={() => void rpc.call("file.open", { path: fileHint }).catch(() => undefined)}
                  title="Open file"
                >
                  ↗ Open file
                </button>
              </div>
            );
          }
          return null;
        })}
      </>
    );
  } else if (part.state.status === "error") {
    title = `${part.name} — failed`;
    body = <pre className="tool-error">{part.state.error?.message ?? "error"}</pre>;
  } else {
    title = `${part.name} — ${part.state.status}`;
  }

  return (
    <div className={`tool-card st-${part.state.status} kind-${kind}`}>
      <button type="button" className="tool-head" onClick={() => setExpanded((v) => !v)}>
        <span className={`chev${expanded ? " open" : ""}`}>▸</span> {title}
      </button>
      {expanded && <div className="tool-body">{body}</div>}
    </div>
  );
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 1);
  } catch {
    return String(error);
  }
}
