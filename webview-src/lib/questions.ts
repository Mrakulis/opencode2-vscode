/**
 * Question tool (`part.name === "question"`) input parsing — pure helpers kept
 * out of `Feed.tsx` so plain node tests can load them (same pattern as
 * `lib/failure.ts`).
 */

export interface QuestionOption {
  label?: string;
  description?: string;
}

export interface QuestionItem {
  question?: string;
  header?: string;
  options?: QuestionOption[];
}

/** Loose shape of the question tool part's `state` — `input` may be an object
 *  or a raw JSON string depending on streaming phase (see parseQuestionInput). */
export interface QuestionToolState {
  status: string;
  input?: unknown;
  error?: { message?: string };
}

/**
 * A question tool part parked awaiting the user: `type:"tool"` and still
 * live (`running`/`streaming` — input may still stream when it parks).
 * Returns the tool call id, or undefined. Single helper: the open-check and
 * the interrupt effect must never disagree.
 */
export function isParkedQuestionPart(p: unknown): string | undefined {
  if (typeof p !== "object" || p === null) return undefined;
  const rec = p as {
    type?: unknown;
    name?: unknown;
    id?: unknown;
    state?: unknown;
  };
  if (rec.type !== "tool" || rec.name !== "question") return undefined;
  const status = (rec.state as { status?: unknown } | null | undefined)
    ?.status;
  if (status !== "running" && status !== "streaming") return undefined;
  return typeof rec.id === "string" && rec.id ? rec.id : undefined;
}

/**
 * A question tool part parked awaiting the user AND already carrying a
 * parseable question list. The run must not be interrupted while the question
 * input is still streaming — `state.input` is a raw JSON string that only
 * becomes parseable once complete, and interrupting too early hands the turn
 * back before the question exists (empty "no question data" card). Returns the
 * tool call id only when a real question is present, else undefined.
 */
export function isParkedQuestionWithData(p: unknown): string | undefined {
  const id = isParkedQuestionPart(p);
  if (!id) return undefined;
  const state = (p as { state?: { input?: unknown } }).state;
  return parseQuestionInput(state?.input).length > 0 ? id : undefined;
}

/**
 * A question tool part in a terminal state (e.g. `error`/`aborted` — the
 * agent-side call is gone, so no hand-back interrupt is needed, but a stale
 * busy flag can wedge the session). Returns the tool call id, or undefined.
 * Parts still arriving (no string status yet) are NOT terminal.
 */
export function isTerminalQuestionPart(p: unknown): string | undefined {
  if (typeof p !== "object" || p === null) return undefined;
  const rec = p as {
    type?: unknown;
    name?: unknown;
    id?: unknown;
    state?: unknown;
  };
  if (rec.type !== "tool" || rec.name !== "question") return undefined;
  const status = (rec.state as { status?: unknown } | null | undefined)
    ?.status;
  if (typeof status !== "string") return undefined;
  if (status === "running" || status === "streaming") return undefined;
  return typeof rec.id === "string" && rec.id ? rec.id : undefined;
}

/**
 * Parse a question tool's `state.input`. The SDK emits a raw JSON string
 * while the tool call is still streaming and an object once running, so both
 * shapes must resolve to the question list (an unparseable string used to
 * flash "no question data" until the status flipped).
 */
export function parseQuestionInput(input: unknown): QuestionItem[] {
  let raw: unknown = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const questions = (raw as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter(
    (q): q is QuestionItem => !!q && typeof q === "object" && !Array.isArray(q),
  );
}
