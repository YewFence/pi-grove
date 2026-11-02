import type { QuestionAnswer } from "./types.js";

/**
 * Placeholder for empty / null answer text. Used uniformly across both variants — the
 * earlier `(no answer)` fallback in the dialog summary was accidental drift; tests pin
 * `(no input)` only.
 */
export const NO_INPUT_PLACEHOLDER = "(no input)";

export type FormatAnswerVariant = "summary" | "envelope";

/**
 * Format a `QuestionAnswer` to its scalar string form. `variant` is currently unused
 * across all branches (the chat branch that once distinguished `envelope` from
 * `summary` has been removed); it is retained on the signature for stability.
 */
export function formatAnswerScalar(a: QuestionAnswer, _variant: FormatAnswerVariant): string {
  return a.selected.length > 0 ? a.selected.join(", ") : NO_INPUT_PLACEHOLDER;
}
