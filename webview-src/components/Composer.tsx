import { useCallback, useEffect, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { rpc } from "../lib/rpc";

interface Props {
  disabled: boolean;
  busy: boolean;
  sendKey: "enter" | "ctrlEnter";
  onSend(text: string): Promise<void> | void;
  onStop(): void;
}

export function Composer({ disabled, busy, sendKey, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // auto-grow up to ~40vh
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    setPreview(false);
    try {
      await onSend(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setError(undefined), 4000);
    }
  }, [text, busy, onSend]);

  return (
    <div className="composer">
      {error && <div className="composer-error">{error}</div>}
      <textarea
        ref={ref}
        rows={1}
        placeholder={disabled ? "Connect to start a session…" : busy ? "Agent working — send to queue after it finishes" : "Ask OpenCode…  (Enter to send, Shift+Enter for newline)"}
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            const allowed = sendKey === "enter" || e.ctrlKey || e.metaKey;
            if (!allowed) return; // plain Enter inserts a newline
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-bar">
        <button
          type="button"
          className={`chip${preview ? " on" : ""}`}
          title="Toggle markdown preview"
          onClick={() => setPreview((v) => !v)}
          disabled={!text.trim()}
        >
          preview
        </button>
        <span className="spacer" />
        {busy ? (
          <button type="button" className="primary stop" onClick={onStop} title="Interrupt">
            ■ stop
          </button>
        ) : (
          <button type="button" className="primary" disabled={disabled || !text.trim()} onClick={() => void submit()}>
            send ▷
          </button>
        )}
      </div>
      {preview && (
        <div className="md preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      )}
    </div>
  );
}

/** File-mention helper used by the header overflow in M3; kept here so the
 * rpc surface is exercised early. */
export async function searchFiles(query: string): Promise<string[]> {
  try {
    const res = await rpc.call<{ path?: string }[] | string[]>("files.find", { query });
    if (Array.isArray(res)) {
      return res.map((r) => (typeof r === "string" ? r : (r.path ?? ""))).filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}
