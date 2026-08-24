import { useEffect, useRef, useState } from "react";
import {
  isAssistant,
  isUser,
  type AnyMessage,
  type MessagePartText,
  type MessagePartReasoning,
  type MessagePartTool,
} from "../lib/rpc";
import { renderMarkdown } from "../lib/markdown";
import {
  diffLines,
  formatCost,
  formatTokens,
  toolTitle,
  truncate,
} from "../lib/format";
import { synthEditDiff, synthWriteDiff } from "../lib/difftext";
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
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  // Ensure chronological order: oldest at top, newest at bottom.
  const sortedMessages = [...messages].sort((a, b) => {
    const ta =
      (a as unknown as { time?: { created?: number } }).time?.created ?? 0;
    const tb =
      (b as unknown as { time?: { created?: number } }).time?.created ?? 0;
    if (ta === 0 && tb === 0) return 0;
    return ta - tb;
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastScrollTopRef.current = el.scrollTop;
    /**
     * Only a real upward scroll unpins. Growing content (shell blocks,
     * images, streaming text) increases scrollHeight WITHOUT firing a
     * scroll event, so it can never be mistaken for the user scrolling —
     * that was the miscalculation with the old distance-only heuristic.
     */
    const onScroll = (): void => {
      const prev = lastScrollTopRef.current;
      lastScrollTopRef.current = el.scrollTop;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (el.scrollTop < prev - 1) {
        // scrolled up → unpin
        pinnedRef.current = false;
        setShowJump(true);
        return;
      }
      const threshold = Math.max(48, el.clientHeight * 0.05);
      if (distance < threshold) {
        if (!pinnedRef.current) pinnedRef.current = true;
        setShowJump(false);
      }
      // otherwise: keep the current pin state (downward drift while reading)
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Glue to the bottom whenever the CONTENT resizes while pinned — this
  // catches everything React misses: image loads, details expansion,
  // code-block wrapping, streaming growth between renders.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Follow output only while the user stays pinned to the bottom.
  // Resumes automatically after the user clicks "Jump to latest".
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
          <div className="feed-empty-hint">
            Ask anything about this workspace — explain a file, fix a bug, or
            plan a feature. Your context is the open folder.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="feed-scroll" ref={scrollRef}>
      <div className="feed-content" ref={contentRef}>
        {sortedMessages.map((m) => (
          <MessageGroup
            key={m.id}
            message={m}
            busy={busy}
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
              pinnedRef.current = true;
              setShowJump(false);
              if (el) {
                el.scrollTop = el.scrollHeight;
                lastScrollTopRef.current = el.scrollTop;
              }
            }}
          >
            ↓ Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

function MessageGroup({
  message,
  busy,
  showReasoning,
  expandShellTools,
  expandEditTools,
  fullShellOutput,
  messageStats,
}: {
  message: AnyMessage;
  busy: boolean;
  showReasoning: "hide" | "collapsed" | "expanded";
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
  messageStats: boolean;
}) {
  if (isUser(message)) {
    return (
      <article className="msg user">
        {message.files && message.files.length > 0 && (
          <div className="user-files">
            {message.files.map((f, i) =>
              f.uri && /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.uri) ? (
                <img
                  key={i}
                  className="user-file-img"
                  src={f.uri}
                  alt={f.name ?? "attachment"}
                />
              ) : (
                <code key={i} className="perm-res">
                  {f.name ?? f.uri}
                </code>
              ),
            )}
          </div>
        )}
        <div className="bubble">{message.text}</div>
      </article>
    );
  }
  if (!isAssistant(message)) {
    // Deliberate rendering for V2 meta message types (system, compaction,
    // skill, shell, agent/model selected, location switched) — shown as a
    // quiet status line instead of being dropped.
    const label: Record<string, string> = {
      system: "system",
      compaction: "context compacted",
      skill: "skill ran",
      shell: "shell command",
      "agent-selected": "agent switched",
      "model-selected": "model switched",
      synthetic: "note",
    };
    const type =
      typeof (message as { type?: string }).type === "string"
        ? (message as { type: string }).type
        : "";
    if (type.length === 0) return null;
    return (
      <article className="msg meta" title={type}>
        <span className="meta-label">{label[type] ?? type}</span>
      </article>
    );
  }

  return (
    <article className="msg assistant">
      <header className="msg-head">
        {message.agent} · {message.model?.id ?? ""}
      </header>
      {message.content?.map((part, i) => (
        <Part
          key={i}
          part={part}
          busy={busy}
          showReasoning={showReasoning}
          expandShellTools={expandShellTools}
          expandEditTools={expandEditTools}
          fullShellOutput={fullShellOutput}
        />
      ))}
      {messageStats &&
        (message.cost !== undefined || message.tokens !== undefined) && (
          <footer className="msg-foot">
            {message.tokens && (
              <span
                title={`input ${message.tokens.input} · output ${message.tokens.output} · reasoning ${message.tokens.reasoning} · cache read ${message.tokens.cache.read} · cache write ${message.tokens.cache.write}`}
              >
                ↑{formatTokens(message.tokens.input)} ↓
                {formatTokens(message.tokens.output)}
                {message.tokens.reasoning > 0
                  ? ` ✻${formatTokens(message.tokens.reasoning)}`
                  : ""}
              </span>
            )}
            {message.cost !== undefined && (
              <span>{formatCost(message.cost)}</span>
            )}
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
      try {
        p = decodeURIComponent(p);
      } catch {}
      void rpc.call("file.open", { path: p }).catch(() => undefined);
      return;
    }
  }
  // 2) inline <code> file paths like `src/foo.ts:12`
  const code = target.closest("code");
  if (code) {
    const txt = (code.textContent ?? "").trim();
    if (
      /^[\w\-./\\]+:\d+/.test(txt) ||
      /^[\w\-./\\]+\.(ts|tsx|js|json|md|css|rs|py|go)\b/.test(txt)
    ) {
      e.preventDefault();
      const m = txt.match(/^(.+?)(?::\d+.*)?$/);
      const p = m ? m[1] : txt;
      void rpc.call("file.open", { path: p }).catch(() => undefined);
    }
  }
}

function Part({
  part,
  busy,
  showReasoning,
  expandShellTools,
  expandEditTools,
  fullShellOutput,
}: {
  part: MessagePartText | MessagePartReasoning | MessagePartTool;
  busy: boolean;
  showReasoning: "hide" | "collapsed" | "expanded";
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
}) {
  if (part.type === "text") {
    return (
      <div
        className="md"
        onClick={handleFileClick}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }}
      />
    );
  }
  if (part.type === "reasoning") {
    if (showReasoning === "hide") return null;
    return (
      <Reasoning
        text={part.text}
        defaultOpen={showReasoning === "expanded"}
        busy={busy}
      />
    );
  }
  if (part.type === "tool") {
    return (
      <ToolCard
        part={part}
        expandShellTools={expandShellTools}
        expandEditTools={expandEditTools}
        fullShellOutput={fullShellOutput}
      />
    );
  }
  return null;
}

function Reasoning({
  text,
  defaultOpen,
  busy,
}: {
  text: string;
  defaultOpen: boolean;
  busy: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || busy);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  useEffect(() => {
    if (busy && text.trim()) setOpen(true);
  }, [busy, text]);
  if (!text.trim()) return null;
  return (
    <details
      className="reasoning"
      data-busy={busy ? "true" : "false"}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        thinking{busy ? " · streaming" : ""}
        {busy && <span className="reasoning-caret" aria-hidden />}
      </summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "terminal",
  "exec",
  "command",
  "powershell",
]);
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply",
  "apply_patch",
  "multiedit",
  "patch",
  "create_file",
  "str_replace",
]);
const READ_TOOLS = new Set([
  "read",
  "read_file",
  "view",
  "open",
  "grep",
  "search",
  "find",
  "glob",
  "glob_search",
  "list",
  "ls",
  "cat",
  "glob_files",
  "file_search",
]);

function toolKind(name: string): "shell" | "edit" | "read" | "other" {
  const n = name.toLowerCase();
  if (/[/.]/.test(n) || SHELL_TOOLS.has(n)) return "shell";
  if (EDIT_TOOLS.has(n) || /edit|diff|patch/.test(n)) return "edit";
  if (READ_TOOLS.has(n) || /read|grep|find|glob|search|list/.test(n))
    return "read";
  return "other";
}

function initiallyExpanded(
  toolName: string,
  shellPref: boolean,
  editPref: boolean,
): boolean {
  const n = toolName.toLowerCase();
  if (/[/.]/.test(n) || SHELL_TOOLS.has(n)) return shellPref;
  if (EDIT_TOOLS.has(n) || /edit|diff|patch/.test(n)) return editPref;
  return false;
}

type ToolPart = MessagePartTool;

function ToolCard({
  part,
  expandShellTools,
  expandEditTools,
  fullShellOutput,
}: {
  part: ToolPart;
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
}) {
  const [expanded, setExpanded] = useState(() =>
    initiallyExpanded(part.name, expandShellTools, expandEditTools),
  );
  useEffect(
    () =>
      setExpanded(
        initiallyExpanded(part.name, expandShellTools, expandEditTools),
      ),
    [part.name, expandShellTools, expandEditTools],
  );
  const kind = toolKind(part.name);

  // Reads aren't worth expanding — just announce the file being read.
  if (kind === "read") {
    const st = part.state as {
      status: string;
      input?: Record<string, unknown>;
      error?: { message?: string };
    };
    const target =
      typeof st.input?.filePath === "string"
        ? st.input.filePath
        : typeof st.input?.path === "string"
          ? st.input.path
          : typeof st.input?.pattern === "string"
            ? `“${st.input.pattern}”`
            : undefined;
    const failed = st.status === "error";
    const busy = st.status === "running" || st.status === "streaming";
    return (
      <div className={`tool-card kind-read st-${st.status} static`}>
        <div className="tool-head" role="presentation">
          {failed ? "✗ " : busy ? "…" : ""}
          {target ? `${part.name} ${target}` : truncate(part.name, 40)}
          {failed && (
            <span className="tool-error-inline">
              {(st.error?.message ?? "").slice(0, 120)}
            </span>
          )}
        </div>
      </div>
    );
  }

  let title = part.name;
  let body: React.ReactNode = null;

  if (part.state.status === "completed") {
    // shell header should just say "shell" — command goes inside the body as terminal
    title =
      kind === "shell" ? "shell" : toolTitle(part.name, part.state.input ?? {});
    const input = (part.state.input ?? {}) as Record<string, unknown>;
    const fileHint =
      typeof input.filePath === "string"
        ? input.filePath
        : typeof input.path === "string"
          ? input.path
          : typeof input.file === "string"
            ? input.file
            : undefined;
    // V2 edit/write results carry no diff — synthesize one from their inputs.
    // (write tools classify as kind "edit"; detect by input shape, not name)
    const synth =
      typeof input.oldString === "string" || typeof input.newString === "string"
        ? synthEditDiff(
            typeof input.oldString === "string" ? input.oldString : "",
            typeof input.newString === "string" ? input.newString : "",
          )
        : typeof input.content === "string"
          ? synthWriteDiff(input.content)
          : "";
    const shellCmd =
      kind === "shell" &&
      typeof (part.state.input as Record<string, unknown> | undefined)
        ?.command === "string"
        ? ((part.state.input as Record<string, unknown>).command as string)
        : typeof (part.state.input as Record<string, unknown> | undefined)
              ?.cmd === "string"
          ? ((part.state.input as Record<string, unknown>).cmd as string)
          : undefined;
    body = (
      <>
        {kind === "shell" && shellCmd && (
          <pre className="tool-cmd">{`$ ${shellCmd}`}</pre>
        )}
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
                        void rpc
                          .call("file.open", { path: file })
                          .catch(() => undefined);
                      }}
                      style={{
                        color: "var(--oc2-link)",
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
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
              <pre
                key={i}
                className={`tool-out${kind === "shell" ? " terminal" : ""}${fullShellOutput ? " full" : ""}`}
                onClick={handleFileClick}
              >
                {fullShellOutput ? txt : truncate(txt, 4000)}
              </pre>
            );
          }
          // Explicit diffs from the server are rendered once below via DiffView.
          if (typeof (c as { diff?: unknown }).diff === "string") return null;
          // Tool-produced files (screenshots, exports): render images inline,
          // everything else as a clickable file chip.
          if (c.type === "file") {
            const f = c as { uri?: string; mime?: string; name?: string };
            if (!f.uri) return null;
            const isImage =
              typeof f.mime === "string"
                ? f.mime.startsWith("image/")
                : /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.uri);
            return isImage ? (
              <img
                key={i}
                className="tool-file-img"
                src={f.uri}
                alt={f.name ?? "tool output"}
              />
            ) : (
              <pre key={i} className="tool-out" onClick={handleFileClick}>
                <a
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void rpc
                      .call("file.open", { path: f.uri! })
                      .catch(() => undefined);
                  }}
                  style={{ color: "var(--oc2-link)", cursor: "pointer" }}
                >
                  ⤒ {f.name ?? f.uri}
                </a>
              </pre>
            );
          }
          return null;
        })}
        {(() => {
          // Prefer an explicit server-provided diff; otherwise synthesize one
          // from the edit/write inputs so every change shows what replaced what.
          const explicit = part.state.content?.find(
            (c) => typeof (c as { diff?: unknown }).diff === "string",
          ) as { diff: string } | undefined;
          const diff = explicit?.diff ?? synth;
          if (!diff) return null;
          return <DiffView diff={diff} file={fileHint ?? "edit.diff"} />;
        })()}
      </>
    );
  } else if (part.state.status === "error") {
    title = `${part.name} — failed`;
    body = (
      <pre className="tool-error">{part.state.error?.message ?? "error"}</pre>
    );
  } else {
    title = `${part.name} — ${part.state.status}`;
  }

  return (
    <div className={`tool-card st-${part.state.status} kind-${kind}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setExpanded((v) => !v)}
      >
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

/** Colored diff body with open-in-editor / open-file actions. */
function DiffView({ diff, file }: { diff: string; file?: string }) {
  return (
    <div>
      <pre className="diff">
        {diffLines(diff).map((l, j) => (
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
        onClick={() =>
          void rpc.call("diff.open", { file, diff }).catch(() => undefined)
        }
        title="Open diff in editor"
      >
        ↔ Open diff
      </button>
      {file && (
        <button
          type="button"
          className="chip"
          style={{ marginLeft: "6px" }}
          onClick={() =>
            void rpc.call("file.open", { path: file }).catch(() => undefined)
          }
          title="Open file"
        >
          ↗ Open file
        </button>
      )}
    </div>
  );
}
