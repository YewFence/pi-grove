/**
 * RPC / dialog-primitive fallback for `ask_user_question`.
 *
 * The canonical TUI path (`ctx.ui.custom()`) renders a tabbed overlay that
 * needs a real terminal. RPC-mode hosts (the VSCode pendant, ACP clients such
 * as Zed or Paseo) report `hasUI: true` because pi's dialog sub-protocol
 * (`extension_ui_request`/`extension_ui_response`) works, but `ui.custom()`
 * resolves `undefined` without rendering anything (issue #78). `ui.select()`
 * and `ui.input()` ARE functional there — the host renders them natively — so
 * this module walks the questions sequentially with those primitives and
 * returns the same `QuestionnaireResult` shapes the TUI produces, feeding the
 * shared `buildQuestionnaireResponse` envelope.
 *
 * Parity trade-offs vs the TUI, inherent to the select/input API surface: no
 * side-by-side preview pane (previews are folded into the prompt title), no
 * tabbed multi-question review (one dialog per question), and multi-select is
 * a free-text numbers input instead of checkbox rows. The "Type something."
 * escape is preserved on both variants — multi-select accepts a trailing
 * custom text segment after the numbers, merged into `selected`.
 */

import { ROW_INTENT_META } from "./state/row-intent.js";
import type {
  QuestionAnswer,
  QuestionData,
  QuestionnaireResult,
  QuestionParams,
} from "./tool/types.js";

const MULTI_SELECT_INSTRUCTIONS =
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), optionally followed by custom text (e.g. "1,3 something else").';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3";

/** Longest preview slice folded into a select title before truncation. */
const MAX_PREVIEW_CHARS = 600;

/**
 * The dialog-primitive slice of `ExtensionUIContext` this walker needs.
 * Structural on purpose: the pinned pi 0.74 peer types predate `ctx.mode`,
 * and jiti transpiles without type-checking — `hasDialogUI` is the runtime
 * gate that makes the shape trustworthy.
 */
export type DialogUI = {
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
};

/** True when the host implements the select/input dialog primitives. */
export function hasDialogUI(ui: unknown): ui is DialogUI {
  const u = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
  return typeof u?.select === "function" && typeof u?.input === "function";
}

type Option = QuestionData["options"][number];

function formatOptionLine(option: Option, index: number): string {
  return `${index + 1}. ${option.label} — ${option.description}`;
}

/**
 * Parse a user-entered (or select-returned) "N…" token to a 0-based option
 * index. `parseInt` reads the leading digits of "2. B — b" as 2; NaN and
 * out-of-range fail the bounds check and return null.
 */
function parseIndex(token: string, count: number): number | null {
  const i = Number.parseInt(token, 10) - 1;
  return i >= 0 && i < count ? i : null;
}

/** Previews folded into the select title — RPC has no side-by-side pane. */
function buildPreviewBlock(question: QuestionData): string {
  const blocks = question.options.flatMap((o, i) =>
    o.preview && o.preview.length > 0
      ? [`--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, MAX_PREVIEW_CHARS)}`]
      : [],
  );
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

/**
 * Walk the questionnaire one native dialog at a time. Dismissing any dialog
 * (the primitive resolves `undefined`) cancels the whole questionnaire —
 * mirroring Esc in the TUI — and the shared envelope emits DECLINE. A
 * `QuestionAnswer` is produced per question otherwise, so the envelope is
 * identical to the TUI path's.
 */
export async function runRpcQuestionnaire(
  ui: DialogUI,
  params: QuestionParams,
): Promise<QuestionnaireResult> {
  const answers: QuestionAnswer[] = [];
  for (const [qi, q] of params.questions.entries()) {
    const header = q.header ? `[${q.header}] ` : "";
    const answer = q.multiSelect
      ? await askMultiSelect(ui, q, qi, header)
      : await askSingleSelect(ui, q, qi, header);
    if (answer === undefined) return { answers, cancelled: true };
    answers.push(answer);
  }
  return { answers, cancelled: false };
}

/** `undefined` means the user dismissed the dialog (cancel the questionnaire). */
async function askSingleSelect(
  ui: DialogUI,
  q: QuestionData,
  questionIndex: number,
  header: string,
): Promise<QuestionAnswer | undefined> {
  const options = q.options.map(formatOptionLine);
  options.push(`${q.options.length + 1}. ${ROW_INTENT_META.other.label}`);
  const chosen = await ui.select(`${header}${q.question}${buildPreviewBlock(q)}`, options);
  if (chosen == null) return undefined;
  const idx = parseIndex(chosen, options.length);
  // A host returning something outside the offered list is indistinguishable
  // from a dismissal — treat it as one rather than fabricate an answer.
  if (idx == null) return undefined;
  if (idx < q.options.length) {
    return { questionIndex, question: q.question, selected: [q.options[idx]!.label] };
  }
  // "Type something." sentinel → free-text follow-up.
  const typed = await ui.input(`${header}${q.question}\n\n${CUSTOM_ANSWER_TITLE}`, "");
  if (typed == null) return undefined;
  return { questionIndex, question: q.question, selected: typed.length > 0 ? [typed] : [] };
}

/** `undefined` means the user dismissed the dialog (cancel the questionnaire). */
async function askMultiSelect(
  ui: DialogUI,
  q: QuestionData,
  questionIndex: number,
  header: string,
): Promise<QuestionAnswer | undefined> {
  const list = q.options.map(formatOptionLine).join("\n");
  const value = await ui.input(
    `${header}${q.question}\n\n${list}\n\n${MULTI_SELECT_INSTRUCTIONS}`,
    MULTI_SELECT_PLACEHOLDER,
  );
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // Deliberate empty commit — same as committing with nothing checked.
    return { questionIndex, question: q.question, selected: [] };
  }
  // Leading numeric tokens are option indices; the first non-numeric token
  // starts a custom-text segment that runs to the end of the input, so
  // "1,3 partly both" selects options 1 and 3 AND contributes "partly both".
  const segments = trimmed.split(",").map((s) => s.trim());
  const selected: string[] = [];
  let customStart = -1;
  for (const [i, seg] of segments.entries()) {
    const idx = /^\d+\.?$/.test(seg) ? parseIndex(seg, q.options.length) : null;
    if (idx == null) {
      customStart = i;
      break;
    }
    const label = q.options[idx]!.label;
    if (!selected.includes(label)) selected.push(label);
  }
  if (customStart >= 0) {
    const custom = segments.slice(customStart).join(", ").trim();
    if (custom.length > 0) selected.push(custom);
  }
  return { questionIndex, question: q.question, selected };
}
