import { type Static, Type } from "typebox";
import { DEFAULT_MAX_QUESTIONS } from "../config.js";
import { LABELS_BY_KIND } from "../state/row-intent.js";
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/**
 * User-facing labels for the three runtime sentinel rows, keyed by their
 * `WrappingSelectItem.kind` discriminator. Sourced from
 * `ROW_INTENT_META` via `LABELS_BY_KIND` (`row-intent.ts`) — single source of
 * truth. Adding a new sentinel requires extending the `WrappingSelectItem`
 * union AND adding an entry to `ROW_INTENT_META`; this map then auto-extends.
 */
export const SENTINEL_LABELS = LABELS_BY_KIND;

export type SentinelKind = keyof typeof SENTINEL_LABELS;
export type SentinelLabel = (typeof SENTINEL_LABELS)[SentinelKind];

/**
 * Labels reserved for Pi-internal sentinels — authoring an option with any
 * of these labels triggers the `reserved_label` runtime guard. Two of the
 * three come from `ROW_INTENT_META` (the runtime kinds); `"Other"` is
 * reserved for CC parity only (the model is conditioned to reach for
 * "Other" in CC; we reject it so the runtime sentinel is the single source
 * of truth) and has no runtime kind.
 *
 * Reserved unconditionally — every question mode rejects these labels, even
 * when a given runtime sentinel is not appended in that mode.
 *
 * Order is pinned by `types.test.ts:292` — keep the explicit
 * `["Other", other, next]` literal so consumers using
 * `RESERVED_LABELS[i]` indexing or `Set` membership see no behavior change.
 */
export const RESERVED_LABELS = ["Other", ...Object.values(LABELS_BY_KIND)] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

export const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
  }),
  description: Type.String({
    description:
      "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
    }),
  ),
});

export const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description:
      "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    }),
  ),
});

export function createQuestionsSchema(maxQuestions: number = DEFAULT_MAX_QUESTIONS) {
  return Type.Array(QuestionSchema, {
    minItems: 1,
    ...(maxQuestions === 0 ? {} : { maxItems: maxQuestions }),
    description:
      maxQuestions === 0
        ? "Questions to ask the user (at least 1 question; no configured maximum)"
        : `Questions to ask the user (1-${maxQuestions} questions)`,
  });
}

export function createQuestionParamsSchema(maxQuestions: number = DEFAULT_MAX_QUESTIONS) {
  return Type.Object({
    questions: createQuestionsSchema(maxQuestions),
  });
}

export const QuestionsSchema = createQuestionsSchema();

export const QuestionParamsSchema = createQuestionParamsSchema();

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

/**
 * A single question's committed answer.
 *
 * `selected` holds the chosen items: option labels and/or custom free-text,
 * homogeneously mixed. Single-select yields exactly one entry; multi-select
 * yields zero or more. A custom text entry is simply a string that matches no
 * option label — no discriminator is needed.
 */
export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  selected: string[];
  notes?: string;
}

export type QuestionnaireError =
  | "no_ui"
  | "no_custom_ui"
  | "no_questions"
  | "empty_options"
  | "too_many_questions"
  | "duplicate_question"
  | "duplicate_option_label"
  | "reserved_label"
  | "session_load_failed"
  | "stale_module_cache";

export interface QuestionnaireResult {
  answers: QuestionAnswer[];
  cancelled: boolean;
  /**
   * Global note authored on the Submit tab: `n` opens the shared notes editor there,
   * and the committed text lives at the `notesByTab[questions.length]` pseudo-index
   * (a slot no question tab can occupy) until `doneFor` lifts it onto the result —
   * attached on both submit and cancel, like per-question `answers[].notes`.
   * Conditional-spread contract, mirroring `QuestionAnswer.notes`: the key appears
   * only via conditional spread of a non-empty string — never assigned `undefined`,
   * never kept for an empty/whitespace-only draft — so note-free results stay
   * byte-identical (`!("globalNote" in result)` holds).
   */
  globalNote?: string;
  error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.answers) && typeof v.cancelled === "boolean";
}
