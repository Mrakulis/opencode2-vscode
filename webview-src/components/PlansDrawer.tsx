import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import {
  nextTask,
  parsePlanTasks,
  setTaskStatus,
  type PlanTask,
} from "../lib/plans";

interface Props {
  onClose(): void;
  /** Whether a session is open (Run Next Task sends through it). */
  canRun: boolean;
  /** Sends a prompt for the next task through the normal send path. */
  onRunPrompt(text: string): void;
}

/**
 * Bespoke implementation-plan checklist (no V2 server contract): parses the
 * workspace's implementation_plan.md into an interactive list, writes toggles
 * back to the file, and offers a "Run Next Task" prompt.
 */
export function PlansDrawer({ onClose, canRun, onRunPrompt }: Props) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const [content, setContent] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // Ref mirror + serialized saves: rapid toggles must build on the LATEST
  // content (not a stale render closure), and the 3s poll must not clobber
  // an optimistic toggle while its save is in flight.
  const contentRef = useRef<string | undefined>(undefined);
  const savingRef = useRef(0);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  const refresh = useCallback(async () => {
    try {
      const res = await rpc.call<{ path?: string; content?: string }>(
        "plan.read",
      );
      setPath(res.path);
      // Don't overwrite an optimistic toggle mid-save; the chain re-reads
      // after the last save lands.
      if (savingRef.current === 0) {
        contentRef.current = res.content;
        setContent(res.content);
      } else {
        setPath(res.path);
      }
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Light poll keeps toggles in sync with external edits while open.
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const tasks: PlanTask[] = content ? parsePlanTasks(content) : [];

  const toggle = async (t: PlanTask): Promise<void> => {
    if (!path) return;
    const base = contentRef.current;
    if (!base) return;
    const next =
      t.status === "done" ? "open" : ("done" as PlanTask["status"]);
    const updated = setTaskStatus(base, t.line, next);
    contentRef.current = updated;
    setContent(updated); // optimistic
    savingRef.current++;
    // Serialize saves so rapid toggles land in order; only the LAST save
    // re-reads, and a failure re-reads to discard just the failed write.
    const run = saveChainRef.current.then(async () => {
      try {
        await rpc.call("plan.save", { path, content: updated });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        const res = await rpc
          .call<{ path?: string; content?: string }>("plan.read")
          .catch(() => undefined);
        if (res) {
          contentRef.current = res.content;
          setContent(res.content);
        }
      } finally {
        savingRef.current--;
      }
    });
    saveChainRef.current = run.catch(() => undefined);
    await run;
  };

  const runNext = (): void => {
    const task = nextTask(tasks);
    if (!task) return;
    onRunPrompt(
      `Work on this plan task and mark it done when finished:\n\n${task.title}`,
    );
    onClose();
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="prov-name">Implementation plan</span>
        <span className="micro">bespoke · local file</span>
        <button type="button" onClick={onClose}>
          done
        </button>
      </div>

      {error && <div className="drawer-empty">{error}</div>}
      {!path && !error && (
        <div className="drawer-empty">
          No implementation_plan.md found in the workspace root or .opencode/.
        </div>
      )}

      {tasks.length > 0 && (
        <div
          className="drawer-list"
          style={{ maxHeight: "50vh", overflowY: "auto" }}
        >
          {tasks.map((t) => (
            <label key={t.line} className="model-row checkrow">
              <input
                type="checkbox"
                checked={t.status === "done"}
                onChange={() => void toggle(t)}
              />
              <span
                className="model-name"
                style={{
                  textDecoration:
                    t.status === "done" ? "line-through" : undefined,
                  opacity: t.status === "open" ? 1 : 0.75,
                }}
              >
                {t.status === "inprogress" ? "▸ " : ""}
                {t.title}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="strip">
        <span className="micro">
          {tasks.filter((t) => t.status === "done").length}/{tasks.length}{" "}
          done
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={!nextTask(tasks) || !canRun}
          title="Send the first pending task to the agent as a prompt"
          onClick={runNext}
        >
          ▷ Run Next Task
        </button>
      </div>
    </div>
  );
}
