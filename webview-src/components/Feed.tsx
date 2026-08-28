import { useEffect, useRef, useState } from "react";
import {
  isAssistant,
  isUser,
  type AnyMessage,
  type MessagePartText,
  type MessagePartReasoning,
  type MessagePartTool,
} from "../lib/rpc";
import { assistantFailed } from "../lib/failure";
import { renderMarkdown } from "../lib/markdown";
import {
  diffLines,
  formatCost,
  formatTokens,
  isFileLikeCode,
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
  onRetry,
  retryPendingLast,
  retryNote,
  retryInfo,
  compacting,
  queued,
  onQueuedOpen,
  onUnqueue,
  onCopyMessage,
  onRegenerate,
  onEditMessage,
  agentKind,
}: {
  messages: AnyMessage[];
  busy: boolean;
  showReasoning: "hide" | "collapsed" | "expanded";
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
  messageStats: boolean;
  /** Called when the user clicks an inline Retry pill on a failed message. */
  onRetry?: () => void;
  /** Transport-level failure with no errored message to attach to. */
  retryPendingLast?: boolean;
  /** Server auto-retry status shown under the newest assistant message. */
  retryNote?: string | null;
  /** Server auto-retry card state (attempt/message/action) — in-feed row. */
  retryInfo?: {
    attempt?: number;
    message?: string;
    action?: { title?: string; message?: string; label?: string; link?: string };
  };
  /** True while the server is compacting this session's context. */
  compacting?: boolean;
  /** Queued follow-ups (session inbox) rendered as pending ghost bubbles. */
  queued?: Array<{ id: string; text?: string }>;
  /** Opens the Inbox drawer (bubble click). */
  onQueuedOpen?: () => void;
  /** Removes one queued item. */
  onUnqueue?: (id: string) => void;
  /** Delivers a chosen question-option label into the conversation. */
  /** Per-message actions. */
  onCopyMessage?: (m: AnyMessage) => void;
  onRegenerate?: () => void;
  onEditMessage?: (text: string) => void;
  /** Live agent kind — seeds trailing pending user when no following assistant yet */
  agentKind?: "plan" | "build" | "other";
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const roRafRef = useRef<number | undefined>(undefined);
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

  // Sticky plan/build per user message — explicit tag only.
  // `plan`/`build` get accent, `custom/other` stays plain. No else coercion.
  const userPlanById = (() => {
    const map = new Map<string, "plan" | "build">();
    try {
      // 1) explicit tags (overlay from App + any future server planAtSend)
      for (const m of sortedMessages) {
        if (!isUser(m)) continue;
        const raw = (m as unknown as { planAtSend?: unknown }).planAtSend;
        const id = (m as { id?: string }).id;
        if (!id) continue;
        if (raw === "plan") map.set(id, "plan");
        if (raw === "build") map.set(id, "build");
        if (raw === true) map.set(id, "plan");
        if (raw === false) map.set(id, "build");
      }
      // 2) fallback inference from next assistant's agent for untagged history
      // Seed with live agentKind for trailing pending (no following assistant yet)
      let next: "plan" | "build" | undefined;
      if (agentKind === "plan") next = "plan";
      if (agentKind === "build") next = "build";
      for (let i = sortedMessages.length - 1; i >= 0; i--) {
        const m = sortedMessages[i]!;
        if (isAssistant(m)) {
          const a = ((m as { agent?: unknown }).agent as string | undefined) ?? "";
          const low = a.toLowerCase();
          if (low.includes("plan")) next = "plan";
          if (low.includes("build")) next = "build";
          if (!low.includes("plan") && !low.includes("build")) next = undefined;
        }
        if (isUser(m)) {
          const id = (m as { id?: string }).id;
          if (!id) continue;
          if (map.has(id)) continue;
          if (next === "plan") map.set(id, "plan");
          if (next === "build") map.set(id, "build");
        }
      }
    } catch {
      return new Map<string, "plan" | "build">();
    }
    return map;
  })();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastScrollTopRef.current = el.scrollTop;
    /**
     * Bottom-first pin logic.
     *
     * 1) If we're within 1px of the scroll max, ALWAYS pin: a content-shrink
     *    clamp lands scrollTop exactly on max, which must never be mistaken
     *    for the user scrolling up (source of both the phantom pill and
     *    autoscroll cutting out at turn end).
     * 2) A deliberate upward gesture (>24px or 2% of feed) unpins — one
     *    wheel notch / line doesn't flash the pill.
     * 3) Scrolling down into the tolerance zone re-pins.
     */
    const onScroll = (): void => {
      const prev = lastScrollTopRef.current;
      const dy = el.scrollTop - prev;
      lastScrollTopRef.current = el.scrollTop;
      const dist =
        el.scrollHeight - el.clientHeight - el.scrollTop;

      if (Math.abs(dist) <= 1) {
        pinnedRef.current = true;
        setShowJump(false);
        return;
      }
      if (dy < -Math.max(24, el.clientHeight * 0.02)) {
        pinnedRef.current = false;
        setShowJump(true);
        return;
      }
      if (dist < Math.max(48, el.clientHeight * 0.05)) {
        pinnedRef.current = true;
        setShowJump(false);
      }
      // otherwise keep the current pin state (drift while reading)
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Glue to the bottom whenever the CONTENT resizes while pinned — this
  // catches everything React misses: image loads, details expansion,
  // code-block wrapping, streaming growth between renders.
  // Only while busy — after completion the feed should stay where user left it.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      // rAF-coalesced: a fast fling can resize content many times per frame;
      // one correction per frame is enough and avoids sync-layout churn.
      if (!pinnedRef.current || !busy) return;
      if (roRafRef.current) return;
      roRafRef.current = requestAnimationFrame(() => {
        roRafRef.current = undefined;
        scrollToBottom(scrollRef.current);
      });
    });
    ro.observe(content);
    // Also watch the scroller itself: dock pills appearing/disappearing
    // change the feed height, which would otherwise leave you shy of the
    // latest after Jump.
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (roRafRef.current) cancelAnimationFrame(roRafRef.current);
    };
  }, [busy]);

  // Follow output only while the user stays pinned to the bottom.
  // Resumes automatically after the user clicks "Jump to latest".
  // Only while busy — after completion leave scroll position alone.
  useEffect(() => {
    if (busy && pinnedRef.current) {
      scrollToBottom(scrollRef.current);
      setShowJump(false); // actively following → the pill must be hidden
    }
  }, [sortedMessages, busy]);

  /**
   * Exact, guarded scroll-to-bottom.
   *
   * Assigning `scrollTop = scrollHeight` over-assigns (the browser clamps)
   * and re-assigning every render combined with the browser's scroll
   * anchoring produced the end-of-feed jitter. Now: compute the real max,
   * skip entirely when already within 1px, and disable scroll anchoring on
   * the scroller via CSS.
   */
  function scrollToBottom(el: HTMLDivElement | null): void {
    if (!el) return;
    // Floor to an integer: at display zoom the raw max is fractional, and
    // assigning it made every write land ±1px off the browser's rounding,
    // which read back as "not at the end yet" → endless 1px re-writes
    // (the jitter). Floored target + 1px tolerance converges and stops.
    const max = Math.max(0, Math.floor(el.scrollHeight - el.clientHeight));
    if (Math.abs(el.scrollTop - max) > 1) el.scrollTop = max;
  }

  // A newly sent prompt ALWAYS jumps into view and re-pins the feed —
  // even if the user was scrolled up reading earlier messages.
  const lastMessage = sortedMessages[sortedMessages.length - 1];
  const lastPromptId =
    lastMessage && isUser(lastMessage) ? (lastMessage as { id: string }).id : undefined;
  useEffect(() => {
    if (!lastPromptId) return;
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setShowJump(false);
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    });
  }, [lastPromptId]);

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
        {(() => {
          const lastId = sortedMessages[sortedMessages.length - 1]?.id;
          return sortedMessages.map((m) => (
            <MessageGroup
              key={m.id}
              message={m}
              busy={busy}
              showReasoning={showReasoning}
              expandShellTools={expandShellTools}
              expandEditTools={expandEditTools}
              fullShellOutput={fullShellOutput}
              messageStats={messageStats}
              isLast={m.id === lastId}
              onRetry={onRetry}
              retryPendingLast={retryPendingLast}
              retryNote={retryNote ?? null}
              onCopyMessage={onCopyMessage}
              onRegenerate={onRegenerate}
              onEditMessage={onEditMessage}
              userPlan={isUser(m) ? userPlanById.get((m as { id: string }).id) : undefined}
            />
          ));
        })()}
        {busy && <div className="streaming-caret" aria-label="working" />}

        {/* Transient run-state rows — in the transcript so they scroll with
            history and resolve away naturally (no dock pills). */}
        {busy && retryInfo && (
          <div className="sys-row" role="status">
            <span className="retry-pill">
              ↻ retrying{retryInfo.attempt ? ` (attempt ${retryInfo.attempt})` : ""}
              {retryInfo.message ? ` — ${truncate(retryInfo.message, 120)}` : ""}
            </span>
            {retryInfo.action?.link && (
              <a
                onClick={(e) => {
                  e.preventDefault();
                  void rpc
                    .call("url.open", { url: retryInfo.action!.link })
                    .catch(() => undefined);
                }}
                style={{ color: "var(--oc2-link)", cursor: "pointer" }}
              >
                {retryInfo.action.label ?? "Open"}
              </a>
            )}
          </div>
        )}
        {compacting && (
          <div className="sys-row" role="status">
            <span className="retry-pill">↻ compacting context…</span>
          </div>
        )}

        {/* Queued follow-ups: pending ghosts of the user messages they will
            become when the server delivers them at end of run. */}
        {(queued ?? []).map((q) => (
          <div key={q.id} className="msg-user queued">
            <div className="queued-body">
              <span className="queued-badge" title="Queued — waits for the current run to end">
                ⏳
              </span>
              <span
                className="queued-text"
                title={onQueuedOpen ? "Open inbox" : undefined}
                onClick={() => onQueuedOpen?.()}
              >
                {truncate(q.text ?? "(attachment)", 140)}
              </span>
              {onUnqueue && (
                <button
                  type="button"
                  className="queued-x"
                  title="Remove from queue"
                  onClick={() => onUnqueue(q.id)}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}

        {showJump && (
          <button
            type="button"
            className="jump"
            onClick={() => {
              const el = scrollRef.current;
              pinnedRef.current = true;
              setShowJump(false);
              scrollToBottom(el);
              if (el) lastScrollTopRef.current = el.scrollTop;
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
  isLast,
  onRetry,
  retryPendingLast,
  retryNote,
  onCopyMessage,
  onRegenerate,
  onEditMessage,
  userPlan,
}: {
  message: AnyMessage;
  busy: boolean;
  showReasoning: "hide" | "collapsed" | "expanded";
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
  messageStats: boolean;
  isLast: boolean;
  onRetry?: () => void;
  retryPendingLast?: boolean;
  retryNote?: string | null;
  onCopyMessage?: (m: AnyMessage) => void;
  onRegenerate?: () => void;
  onEditMessage?: (text: string) => void;
  userPlan?: "plan" | "build";
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
        <div
          className="bubble"
          {...(userPlan === "plan"
            ? { "data-plan": "plan" }
            : userPlan === "build"
              ? { "data-plan": "build" }
              : {})}
        >
          {message.text}
        </div>
        {(onCopyMessage || onEditMessage) && (
          <div className="msg-actions">
            {message.text && onCopyMessage && (
              <button type="button" className="chip" onClick={() => onCopyMessage(message)} title="Copy this message">
                📋 copy
              </button>
            )}
            {onEditMessage && (
              <button type="button" className="chip" onClick={() => onEditMessage(message.text)} title="Edit and resend">
                ✎ edit
              </button>
            )}
          </div>
        )}
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
      // real payload types (SDK + live): *-switched; older betas used *-selected
      "agent-switched": "agent switched",
      "agent-selected": "agent switched",
    };
    const type =
      typeof (message as { type?: string }).type === "string"
        ? (message as { type: string }).type
        : "";
    if (type.length === 0) return null;
    // Synthetic messages are token-less checkpoint markers (e.g. compaction
    // bookkeeping) — they carry no user-facing content, so render nothing.
    if (type === "synthetic") return null;
    // Model/agent switches are reflected in the header/StatusStrip — no chat noise.
    if (
      ["model-switched", "model-selected", "agent-switched", "agent-selected"].includes(type)
    )
      return null;
    // Agent/plan lifecycle reminders are already conveyed by the whole-UI tint
    // ([data-plan] / agent chip) — suppress all chat duplicates regardless of agent.
    {
      const raw =
        typeof (message as unknown as { text?: unknown }).text === "string"
          ? (message as unknown as { text: string }).text
          : typeof (message as unknown as { content?: unknown }).content === "string"
            ? (message as unknown as { content: string }).content
            : "";
      const reminderRe = /<system-reminder>|You are (?:in|NO LONGER in)\b/i;
      if (raw && reminderRe.test(raw)) return null;
      if (reminderRe.test(type)) return null;
      // Also check content parts array for that phrase
      const parts = (message as unknown as { content?: Array<{ text?: string }> }).content;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (typeof p?.text === "string" && reminderRe.test(p.text)) return null;
        }
      }
      // Catch JSON-stringified message containing the tag
      try {
        if (reminderRe.test(JSON.stringify(message))) return null;
      } catch {}
    }
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
      {message.content
        ?.filter(
          (p) =>
            !(
              typeof (p as { text?: unknown }).text === "string" &&
              /<system-reminder>|You are (?:in|NO LONGER in)\b/i.test(
                (p as { text: string }).text,
              )
            ),
        )
        .map((part, i) => (
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
      {(onCopyMessage || (isLast && onRegenerate)) && (
        <div className="msg-actions">
          {onCopyMessage && (
            <button
              type="button"
              className="chip"
              onClick={() => onCopyMessage(message)}
              title="Copy this reply"
            >
              📋 copy
            </button>
          )}
          {isLast && onRegenerate && (
            <button
              type="button"
              className="chip"
              onClick={() => onRegenerate()}
              title="Regenerate — send your last prompt again"
            >
              ⟳ regenerate
            </button>
          )}
        </div>
      )}
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
      {message.error != null && !isTransientNetworkError(message.error) && (
        <pre className="tool-error">{stringifyError(message.error)}</pre>
      )}
      {isTransientNetworkError(message.error) && (
        <pre className="tool-error" style={{ opacity: 0.7 }}>
          Connection briefly dropped — retrying automatically. {stripVerboseHint(String((message.error as { message?: string })?.message ?? ""))}
        </pre>
      )}
      {(() => {
        // In-chat retry affordance attached to THIS message: shows only while
        // it is the newest one, then scrolls away as history grows.
        // Transient network errors (ECONNRESET) are non-retryable via manual chip — server auto-retry handles them.
        const failed = assistantFailed(message) && !isTransientNetworkError(message.error);
        const showButton =
          !busy && isLast && (failed || (!!retryPendingLast && !!onRetry && !isTransientNetworkError(message.error)));
        const showNote = busy && isLast && !!retryNote;
        if ((!showButton || !onRetry) && !showNote) return null;
        return (
          <div className="msg-retry">
            {showNote && <span className="retry-pill">{retryNote}</span>}
            {showButton && onRetry && (
              <button
                type="button"
                className="chip on"
                title={
                  message.error != null &&
                  typeof message.error === "object" &&
                  "message" in message.error &&
                  typeof message.error.message === "string"
                    ? `${message.error.message} — click to send the last prompt again.`
                    : "The last prompt failed. Click to send it again."
                }
                onClick={onRetry}
              >
                ↻ Retry
              </button>
            )}
          </div>
        );
      })()}
    </article>
  );
}

function handleFileClick(e: React.MouseEvent) {
  const target = e.target as HTMLElement;
  // 1) markdown links <a href="...">
  const anchor = target.closest("a") as HTMLAnchorElement | null;
  if (anchor) {
    const raw = (anchor.getAttribute("href") ?? "").trim();
    if (!raw) return;
    if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw) || /^vscode:/i.test(raw)) {
      e.preventDefault();
      void rpc.call("url.open", { url: raw }).catch(() => undefined);
      return;
    }
    // everything else is a file-like href (relative path, file://)
    e.preventDefault();
    let p = raw.replace(/^file:\/\//, "");
    try {
      p = decodeURIComponent(p);
    } catch {}
    if (p) void rpc.call("file.open", { path: p }).catch(() => undefined);
    return;
  }
  // 2) inline <code> file paths like `src/foo.ts:12` — only file-like code is clickable
  const code = target.closest("code");
  if (code) {
    const txt = (code.textContent ?? "").trim();
    if (isFileLikeCode(txt)) {
      e.preventDefault();
      const m = txt.match(/^(.+?)(?::\d+.*)?$/);
      const p = m ? m[1] : txt;
      void rpc.call("file.open", { path: p }).catch(() => undefined);
    }
  }
}

function Part(props: {
  part: MessagePartText | MessagePartReasoning | MessagePartTool;
  busy: boolean;
  showReasoning: "hide" | "collapsed" | "expanded";
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
}) {
  const { part, busy, showReasoning, expandShellTools, expandEditTools, fullShellOutput } =
    props as {
      part: MessagePartText | MessagePartReasoning | MessagePartTool;
      busy: boolean;
      showReasoning: "hide" | "collapsed" | "expanded";
      expandShellTools: boolean;
      expandEditTools: boolean;
      fullShellOutput: boolean;
    };
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

/** One nested MCP tool call inside a CodeMode `execute` run. */
interface CodeModeCall {
  tool?: string;
  status?: string;
  input?: unknown;
}

function extractCodeModeState(
  part: ToolPart,
): { code?: string; calls: CodeModeCall[] } {
  const st = part.state as {
    status: string;
    input?: Record<string, unknown> | string;
    metadata?: { [k: string]: unknown };
  };
  let raw = st.input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      raw = { code: raw };
    }
  }
  const code =
    typeof (raw as { code?: unknown })?.code === "string"
      ? ((raw as { code: string }).code)
      : undefined;
  const callsRaw = st.metadata?.toolCalls;
  const calls = Array.isArray(callsRaw) ? (callsRaw as CodeModeCall[]) : [];
  return { code, calls };
}

/**
 * Minimal JS tokenizer for display purposes — keywords, strings, numbers,
 * comments, and tool namespace calls get distinct colors. Purely cosmetic.
 */
function renderHighlightedCode(code: string): React.ReactNode[] {
  const tokens: Array<{ cls?: string; text: string }> = [];
  const re =
    /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|await|async|for|of|in|if|else|while|try|catch|throw|new|typeof|null|undefined|true|false)\b|\b(\d+(?:\.\d+)?)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) tokens.push({ text: code.slice(last, m.index) });
    if (m[1]) tokens.push({ cls: "cm-com", text: m[0] });
    else if (m[2]) tokens.push({ cls: "cm-str", text: m[0] });
    else if (m[3]) tokens.push({ cls: "cm-kw", text: m[0] });
    else tokens.push({ cls: "cm-num", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < code.length) tokens.push({ text: code.slice(last) });
  return tokens.map((t, i) =>
    t.cls ? (
      <span key={i} className={t.cls}>
        {t.text}
      </span>
    ) : (
      <span key={i}>{t.text}</span>
    ),
  );
}

/** Split an execute result into its value part and the trailing Logs block. */
function splitLogs(output: string): { value: string; logs?: string } {
  const idx = output.indexOf("\n\nLogs:\n");
  if (idx === -1) return { value: output };
  return { value: output.slice(0, idx), logs: output.slice(idx + 8) };
}

function CodeModeCard({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(true);
  const { code, calls } = extractCodeModeState(part);
  const status = part.state.status;

  // Result / live output panes.
  let value = "";
  let logs: string | undefined;
  let error: string | undefined;
  if (status === "completed") {
    const texts = (part.state as { content?: Array<{ type: string; text?: string }> })
      .content?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const split = splitLogs(texts ?? "");
    value = split.value;
    logs = split.logs;
  } else if (status === "error") {
    error =
      (part.state as { error?: { message?: string } }).error?.message ??
      "execution failed";
  }

  return (
    <div className={`tool-card kind-other st-${status} codemode`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`chev${expanded ? " open" : ""}`}>▸</span> ⚡ Code
        Mode{" "}
        <span className="micro" style={{ opacity: 0.7 }}>
          {calls.length > 0 ? `· ${calls.length} tool call${calls.length === 1 ? "" : "s"}` : ""}
        </span>
      </button>
      {expanded && (
        <div className="tool-body">
          {code !== undefined && (
            <pre className="tool-cmd codemode-code">
              <code>{renderHighlightedCode(code)}</code>
            </pre>
          )}
          {calls.length > 0 && (
            <div className="codemode-calls">
              {calls.map((c, i) => (
                <div key={i} className="codemode-call">
                  <span className={`call-dot ${c.status ?? "pending"}`} />
                  <code>{c.tool}</code>
                </div>
              ))}
            </div>
          )}
          {(value || error) && (
            <pre className={`tool-out terminal${error ? " tool-error" : ""}`}>
              {error ?? truncate(value, 4000)}
            </pre>
          )}
          {logs && (
            <>
              <div className="micro" style={{ opacity: 0.7, marginTop: 4 }}>
                Sandbox output
              </div>
              <pre className="tool-out terminal">{truncate(logs, 4000)}</pre>
            </>
          )}
          {status === "running" && !calls.length && (
            <div className="micro" style={{ opacity: 0.7 }}>
              …executing sandboxed program
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  // Compact completed tool cards to their one-line summary (keeps the feed
  // from growing unbounded); click still expands for details.
  const toolStatus = part.state.status;
  useEffect(() => {
    if (toolStatus === "completed") setExpanded(false);
  }, [toolStatus]);
  const kind = toolKind(part.name);

  // CodeMode dispatcher: the server funnels MCP tools through one `execute`
  // tool whose input is {code} and metadata streams nested {toolCalls}.
  if (part.name === "execute") {
    return <CodeModeCard part={part} />;
  }

  // Reads aren't worth expanding — just announce the file being read.
  if (kind === "read") {    const st = part.state as {
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

  // Agent-asked questions render inline as plain text in the feed, with the
  // options lettered a/b/c… The OpenCode V2 server exposes no distributed
  // question-reply route, so the user answers naturally in the chat — never a
  // blocking interactive "question window" that can stall the conversation.
  if (part.name === "question") {
    return <QuestionAsText state={part.state as QuestionToolState} />;
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

function isTransientNetworkError(error: unknown): boolean {
  const msg =
    typeof error === "string"
      ? error
      : typeof (error as { message?: unknown })?.message === "string"
        ? (error as { message: string }).message
        : "";
  return /ECONNRESET|socket.*closed/i.test(msg);
}

function stripVerboseHint(text: string): string {
  return text.replace(/\s*For more information, pass `verbose:\s*true`.*$/s, "").trim();
}

function stringifyError(error: unknown): string {
  let raw: string;
  if (typeof error === "string") raw = error;
  else
    try {
      raw = JSON.stringify(error, null, 1);
    } catch {
      raw = String(error);
    }
  return stripVerboseHint(raw);
}

interface QuestionOption {
  label?: string;
  description?: string;
}
interface QuestionItem {
  question?: string;
  header?: string;
  options?: QuestionOption[];
}
interface QuestionToolState {
  status: string;
  input?: { questions?: QuestionItem[] };
  error?: { message?: string };
}

/** Plain-text fallback for agent questions when the server doesn't expose the
 *  question-reply routes (`!ui.questionsSupported`). Renders each question +
 *  its options as readable markdown so the user can simply answer in the chat
 *  — no interactive card, no dependency on the (currently missing) server
 *  question-reply routes. */
function QuestionAsText({ state }: { state: QuestionToolState }) {
  const qs = Array.isArray(state.input?.questions) ? state.input!.questions! : [];
  const md =
    qs.length === 0
      ? "_(no question data)_"
      : qs
          .map((q, i) => {
            const title = q.header ?? q.question ?? `Question ${i + 1}`;
            const lines = [`**${title}**`];
            if (q.question && q.header) lines.push(q.question);
            const opts = Array.isArray(q.options) ? q.options : [];
            opts.forEach((o, oi) => {
              const letter = String.fromCharCode(97 + oi); // a, b, c…
              lines.push(
                `- **${letter})** ${o.label ?? "(unnamed option)"}${o.description ? ` — ${o.description}` : ""}`,
              );
            });
            return lines.join("\n");
          })
          .join("\n\n");
  return (
    <div className={`tool-card kind-question st-${state.status} static`}>
      <div className="tool-head">
        ❓ question {qs.length > 1 ? `(${qs.length})` : ""}
      </div>
      <div className="tool-body">
        <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />
      </div>
    </div>
  );
}

/** Colored diff body + editor actions. Primary action opens VS Code's
 *  side-by-side diff for the real file; the patch text is only passed
 *  along when there is no real file to diff against. */
function DiffView({ diff, file }: { diff: string; file?: string }) {
  const openSideBySide = (): void => {
    void rpc
      .call("diff.open", file ? { file } : { file: "edit.diff", diff })
      .catch(() => undefined);
  };
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
        onClick={openSideBySide}
        title="Open side-by-side diff in the editor"
      >
        ⇔ Open diff
      </button>
      {file && !file.endsWith(".diff") && (
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
