import { formatAnswerScalar } from "./format-answer.js";
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./types.js";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and "no lines" both fall to `DECLINE_MESSAGE`
 * so the model sees a single canonical "didn't answer" signal regardless of why.
 * "No lines" means no answers AND no global note — the `global note:` line is
 * pushed before the zero-lines check, so a note-bearing submit with zero answers
 * still yields the answered envelope.
 *
 * The answered envelope is one line per question, keyed by the question's `header`
 * rather than its full text: the model authored the questions itself, so echoing
 * the prose back added length without information, and the per-line shape keeps
 * both the model-facing text and the transcript rendering scannable.
 */
export function buildQuestionnaireResponse(
  result: QuestionnaireResult | null | undefined,
  params: QuestionParams,
) {
  if (!result || result.cancelled) {
    // Decline text stays canonical even when a global note rides the cancelled result;
    // the note survives in `details` (like partial `answers`) for replay consumers.
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result?.answers ?? [],
      cancelled: true,
      ...(result?.globalNote && result.globalNote.length > 0
        ? { globalNote: result.globalNote }
        : {}),
    });
  }
  const lines: string[] = [];
  for (let i = 0; i < params.questions.length; i++) {
    const a = result.answers.find((x) => x.questionIndex === i);
    if (a) lines.push(buildAnswerSegment(a, params.questions[i], i));
  }
  // Global note rides after the per-question lines: raw multiline echo (no
  // reformatting), mirroring the per-question `user notes:` suffix shape.
  if (result.globalNote && result.globalNote.length > 0) {
    lines.push(`global note: ${result.globalNote}`);
  }
  if (lines.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
  }
  return buildToolResult(`${ENVELOPE_PREFIX}\n${lines.join("\n")}\n${ENVELOPE_SUFFIX}`, result);
}

/**
 * Format a single answer line for the envelope: `<header>="<answer>"` with an
 * optional `. user notes: <text>` suffix. `header` is required by the parameter
 * schema, but an empty string falls back to `Q<index+1>` — the same label the
 * Submit-tab review uses for headerless questions. Pure of `(a, q, index)`.
 */
export function buildAnswerSegment(
  a: QuestionAnswer,
  q: QuestionData | undefined,
  index: number,
): string {
  const label = q?.header && q.header.length > 0 ? q.header : `Q${index + 1}`;
  const parts: string[] = [`${label}="${formatAnswerScalar(a, "envelope")}"`];
  if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
  return parts.join(". ");
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}
