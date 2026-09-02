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
