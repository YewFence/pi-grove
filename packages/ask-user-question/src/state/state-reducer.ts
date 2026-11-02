import type { QuestionAnswer, QuestionData, QuestionnaireResult } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import type { QuestionnaireAction } from "./key-router.js";
import { ROW_INTENT_META } from "./row-intent.js";
import type { QuestionnaireState } from "./state.js";

/** Session-lifetime constants. No live-component reads — peripheral values live on canonical state. */
export interface ApplyContext {
  questions: readonly QuestionData[];
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
}

/**
 * Declarative side-effects emitted by `reduce`. The runtime executes them after
 * committing the new state, then asks the props-adapter to re-project. Closed set —
 * adding an effect requires updating both the union AND the runtime's `runEffect` switch
 * (compiler-enforced exhaustive). No string-keyed escape hatch.
 */
export type Effect =
  | { kind: "set_input_buffer"; value: string }
  | { kind: "clear_input_buffer" }
  | { kind: "open_input_editor"; value: string }
  | { kind: "set_notes_value"; value: string }
  | { kind: "set_notes_focused"; focused: boolean }
  | { kind: "forward_notes_keystroke"; data: string }
  /**
   * Tell the session to hide or show its underlying overlay. Emitted by the
   * `toggle_collapsed` action so the runtime can call `OverlayHandle.setHidden(...)`,
   * which lets other overlay-aware consumers (e.g. `pi-station`) see the questionnaire
   * as truly hidden and resume normal chat scroll while the user reads the transcript
   * behind the modal.
   */
  | { kind: "set_overlay_hidden"; hidden: boolean }
  | { kind: "done"; result: QuestionnaireResult };

export interface ApplyResult {
  state: QuestionnaireState;
  effects: readonly Effect[];
}

function orderedAnswers(
  state: QuestionnaireState,
  questions: readonly QuestionData[],
): QuestionAnswer[] {
  const out: QuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const a = state.answers.get(i);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Rebuild the checkbox set from a committed answer for one tab. Option labels map
 * back to their indices; any entry matching no option label is custom text, which
 * re-checks the "other" row (index `options.length`) when non-empty.
 */
function syncCheckedFromAnswer(
  answer: QuestionAnswer | undefined,
  questions: readonly QuestionData[],
  tab: number,
): ReadonlySet<number> {
  const q = questions[tab];
  if (!q?.multiSelect) return new Set();
  const indices = new Set<number>();
  if (!answer) return indices;
  let custom: string | undefined;
  for (const entry of answer.selected) {
    const idx = q.options.findIndex((o) => o.label === entry);
    if (idx >= 0) indices.add(idx);
    else custom = entry;
  }
  if (custom !== undefined && custom.length > 0) indices.add(q.options.length);
  return indices;
}

function notesValueFor(state: QuestionnaireState, tab: number): string {
  return state.notesByTab.get(tab) ?? state.answers.get(tab)?.notes ?? "";
}

/**
 * The custom text associated with a tab: the in-flight draft when present, else the
 * non-option-label entry of the committed answer (single- or multi-select alike).
 */
function customDraftValueFor(state: QuestionnaireState, tab: number, ctx: ApplyContext): string {
  const draft = state.customDraftsByTab.get(tab);
  if (draft !== undefined) return draft;
  const answer = state.answers.get(tab);
  if (!answer) return "";
  const q = ctx.questions[tab];
  if (!q) return "";
  for (const entry of answer.selected) {
    if (!q.options.some((o) => o.label === entry)) return entry;
  }
  return "";
}

function setCustomDraft(
  state: QuestionnaireState,
  tab: number,
  value: string,
): ReadonlyMap<number, string> {
  const drafts = new Map(state.customDraftsByTab);
  drafts.set(tab, value);
  return drafts;
}

function switchTabResult(
  state: QuestionnaireState,
  nextTab: number,
  ctx: ApplyContext,
): ApplyResult {
  const notesValue = notesValueFor(state, nextTab);
  const transitioned: QuestionnaireState = {
    ...state,
    currentTab: nextTab,
    optionIndex: 0,
    inputMode: false,
    notesVisible: false,
    submitChoiceIndex: 0,
    multiSelectChecked: syncCheckedFromAnswer(state.answers.get(nextTab), ctx.questions, nextTab),
    notesDraft: notesValue,
  };
  return {
    state: transitioned,
    effects: [
      { kind: "set_notes_focused", focused: false },
      { kind: "set_notes_value", value: notesValue },
      { kind: "set_input_buffer", value: customDraftValueFor(state, nextTab, ctx) },
    ],
  };
}

function doneFor(state: QuestionnaireState, ctx: ApplyContext, cancelled: boolean): ApplyResult {
  // Global note lift: the Submit-tab note lives at the `questions.length` pseudo-index
  // in `notesByTab` — question tabs only occupy 0..questions.length-1, so this can never
  // cross-contaminate a per-question note. Attached regardless of `cancelled` (the
  // reducer is truth; the envelope owns decline presentation), with cancel/submit/confirm
  // sharing this single lift. Conditional spread keeps note-free results byte-identical.
  const globalNote = state.notesByTab.get(ctx.questions.length);
  const result: QuestionnaireResult = {
    answers: orderedAnswers(state, ctx.questions),
    cancelled,
    ...(globalNote && globalNote.length > 0 ? { globalNote } : {}),
  };
  return { state, effects: [{ kind: "done", result }] };
}

/**
 * Per-kind handler signature: action payload narrows to the matching union member
 * via `Extract`, so handlers consume fully-typed actions without `as` casts.
 */
type Handler<K extends QuestionnaireAction["kind"]> = (
  state: QuestionnaireState,
  action: Extract<QuestionnaireAction, { kind: K }>,
  ctx: ApplyContext,
) => ApplyResult;

const navHandler: Handler<"nav"> = (state, action, ctx) => {
  const items = ctx.itemsByTab[state.currentTab] ?? [];
  const item = items[action.nextIndex];
  const q = ctx.questions[state.currentTab];
  // Focusing the "other" row auto-enters the editor on single-select tabs only;
  // on multi-select tabs the editor is entered explicitly via Enter.
  const inputMode = item
    ? ROW_INTENT_META[item.kind].activatesInputMode && q?.multiSelect !== true
    : false;
  const customDraftsByTab = state.inputMode
    ? setCustomDraft(state, state.currentTab, action.inputValue)
    : state.customDraftsByTab;
  const next: QuestionnaireState = {
    ...state,
    optionIndex: action.nextIndex,
    inputMode,
    customDraftsByTab,
  };
  if (!inputMode) return { state: next, effects: [] };
  return {
    state: next,
    effects: [
      { kind: "set_input_buffer", value: customDraftValueFor(next, state.currentTab, ctx) },
    ],
  };
};

const inputClearHandler: Handler<"input_clear"> = (state, _action, _ctx) => ({
  state: { ...state, customDraftsByTab: setCustomDraft(state, state.currentTab, "") },
  effects: [{ kind: "clear_input_buffer" }],
});
const inputEditHandler: Handler<"input_edit"> = (state, action, _ctx) => ({
  state,
  effects: [{ kind: "open_input_editor", value: action.value }],
});
const inputReplaceHandler: Handler<"input_replace"> = (state, action, _ctx) => ({
  state: { ...state, customDraftsByTab: setCustomDraft(state, state.currentTab, action.value) },
  effects: [{ kind: "set_input_buffer", value: action.value }],
});

const tabSwitchHandler: Handler<"tab_switch"> = (state, action, ctx) =>
  switchTabResult(state, action.nextTab, ctx);

const confirmHandler: Handler<"confirm"> = (state, action, ctx) => {
  let answer = action.answer;
  const pendingNotes = state.notesByTab.get(answer.questionIndex);
  if (pendingNotes && pendingNotes.length > 0) {
    answer = { ...answer, notes: pendingNotes };
  }
  const answers = new Map(state.answers);
  if (answer.selected.length === 0) {
    // An explicit empty commit clears the tab's answer — toggling everything off
    // and pressing Enter means "leave this question unanswered".
    answers.delete(answer.questionIndex);
  } else {
    answers.set(answer.questionIndex, answer);
  }
  // The draft has been folded into the answer; drop it so tab-back restores from
  // the answer rather than a stale in-flight buffer.
  const customDraftsByTab = new Map(state.customDraftsByTab);
  customDraftsByTab.delete(answer.questionIndex);
  const next: QuestionnaireState = { ...state, answers, customDraftsByTab };
  if (action.autoAdvanceTab !== undefined) return switchTabResult(next, action.autoAdvanceTab, ctx);
  return doneFor(next, ctx, false);
};

const toggleHandler: Handler<"toggle"> = (state, action, _ctx) => {
  const checked = new Set(state.multiSelectChecked);
  if (checked.has(action.index)) checked.delete(action.index);
  else checked.add(action.index);
  return { state: { ...state, multiSelectChecked: checked }, effects: [] };
};

const editEnterHandler: Handler<"edit_enter"> = (state, _action, ctx) => ({
  state: { ...state, inputMode: true },
  effects: [{ kind: "set_input_buffer", value: customDraftValueFor(state, state.currentTab, ctx) }],
});

const editExitHandler: Handler<"edit_exit"> = (state, action, ctx) => {
  const q = ctx.questions[state.currentTab];
  const isMultiSelect = q?.multiSelect === true;
  const checked = new Set(state.multiSelectChecked);
  if (isMultiSelect) {
    const otherIndex = q!.options.length;
    if (action.commit && action.draft.trim().length > 0) checked.add(otherIndex);
    else checked.delete(otherIndex);
  }
  // Focus fallback after leaving the editor: on single-select tabs the "other"
  // row auto-re-enters inputMode on focus, so staying there would strand the
  // cursor in a half-open state (typing dropped, Enter silently confirming the
  // draft). Drop to the first option row instead; multi-select keeps focus on
  // the "other" row where Enter re-opens the editor.
  const optionIndex = !isMultiSelect ? 0 : state.optionIndex;
  return {
    state: {
      ...state,
      optionIndex,
      inputMode: false,
      multiSelectChecked: checked,
      customDraftsByTab: setCustomDraft(state, state.currentTab, action.draft),
    },
    effects: [],
  };
};

const notesEnterHandler: Handler<"notes_enter"> = (state, _action, _ctx) => {
  const value = notesValueFor(state, state.currentTab);
  return {
    state: { ...state, notesVisible: true, notesDraft: value },
    effects: [
      { kind: "set_notes_value", value },
      { kind: "set_notes_focused", focused: true },
    ],
  };
};

const notesExitHandler: Handler<"notes_exit"> = (state, _action, _ctx) => {
  const trimmed = state.notesDraft.trim();
  const notes = new Map(state.notesByTab);
  const answers = new Map(state.answers);
  if (trimmed.length === 0) {
    notes.delete(state.currentTab);
    const prev = answers.get(state.currentTab);
    if (prev?.notes) {
      const stripped = { ...prev };
      delete (stripped as { notes?: string }).notes;
      answers.set(state.currentTab, stripped);
    }
  } else {
    notes.set(state.currentTab, trimmed);
    const prev = answers.get(state.currentTab);
    if (prev) answers.set(state.currentTab, { ...prev, notes: trimmed });
  }
  return {
    state: { ...state, notesByTab: notes, answers, notesVisible: false },
    effects: [{ kind: "set_notes_focused", focused: false }],
  };
};

const cancelHandler: Handler<"cancel"> = (s, _a, c) => doneFor(s, c, true);
const submitHandler: Handler<"submit"> = (s, _a, c) => doneFor(s, c, false);
const submitNavHandler: Handler<"submit_nav"> = (s, a, _c) => ({
  state: { ...s, submitChoiceIndex: a.nextIndex },
  effects: [],
});
const notesForwardHandler: Handler<"notes_forward"> = (s, a, _c) => ({
  state: s,
  effects: [{ kind: "forward_notes_keystroke", data: a.data }],
});
const toggleCollapsedHandler: Handler<"toggle_collapsed"> = (s, _a, _c) => ({
  state: { ...s, collapsed: !s.collapsed },
  effects: [{ kind: "set_overlay_hidden", hidden: !s.collapsed }],
});
const ignoreHandler: Handler<"ignore"> = (s, _a, _c) => ({ state: s, effects: [] });

/**
 * Compile-time-exhaustive dispatch table. `{ [K in Kind]: Handler<K> }` requires
 * an entry per union member — adding a new `QuestionnaireAction` variant fails to
 * compile here until a handler is registered, mirroring the `Record<RowKind, …>`
 * pattern used by `ROW_INTENT_META`.
 */
const HANDLERS: { [K in QuestionnaireAction["kind"]]: Handler<K> } = {
  nav: navHandler,
  input_clear: inputClearHandler,
  input_edit: inputEditHandler,
  input_replace: inputReplaceHandler,
  tab_switch: tabSwitchHandler,
  confirm: confirmHandler,
  toggle: toggleHandler,
  edit_enter: editEnterHandler,
  edit_exit: editExitHandler,
  cancel: cancelHandler,
  notes_enter: notesEnterHandler,
  notes_exit: notesExitHandler,
  notes_forward: notesForwardHandler,
  submit: submitHandler,
  submit_nav: submitNavHandler,
  toggle_collapsed: toggleCollapsedHandler,
  ignore: ignoreHandler,
};

/**
 * Pure reducer: (state, action, ctx) → (state, Effect[]). Mirrors `rpiv-todo`'s `applyTaskMutation`.
 * Delegates to `HANDLERS` — per-kind handlers above are pure, named, and individually testable.
 * `ignore` is also handled outside the reducer by `handleIgnoreInline` in the runtime fast path.
 */
export function reduce(
  state: QuestionnaireState,
  action: QuestionnaireAction,
  ctx: ApplyContext,
): ApplyResult {
  const handler = HANDLERS[action.kind] as Handler<typeof action.kind>;
  return handler(state, action as never, ctx);
}
