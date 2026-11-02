import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionAnswer } from "../tool/types.js";
import { ROW_INTENT_META } from "./row-intent.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_SUBMIT = "tui.input.submit";
const KEYBIND_CANCEL = "tui.select.cancel";
const KEYBIND_NEW_LINE = "tui.input.newLine";
const KEYBIND_EDITOR_UP = "tui.editor.cursorUp";
const KEYBIND_EDITOR_DOWN = "tui.editor.cursorDown";
const KEYBIND_CLEAR = "tui.editor.deleteToLineStart";
const KEYBIND_EXTERNAL_EDITOR = "app.editor.external";

const NOTES_ACTIVATE_KEY = "n";
const SPACE_KEY = " ";

export type QuestionnaireAction =
  | { kind: "nav"; nextIndex: number; inputValue: string }
  | { kind: "input_clear" }
  | { kind: "input_edit"; value: string }
  | { kind: "input_replace"; value: string }
  | { kind: "tab_switch"; nextTab: number }
  | { kind: "confirm"; answer: QuestionAnswer; autoAdvanceTab?: number }
  | { kind: "toggle"; index: number }
  | { kind: "cancel" }
  | { kind: "notes_enter" }
  | { kind: "notes_exit" }
  | { kind: "submit" }
  | { kind: "submit_nav"; nextIndex: 0 | 1 }
  | { kind: "notes_forward"; data: string }
  | { kind: "edit_enter" }
  | { kind: "edit_exit"; commit: boolean; draft: string }
  /** Flip `state.collapsed`. Always available, regardless of inner mode (see top intercept in `routeKey`). */
  | { kind: "toggle_collapsed" }
  | { kind: "ignore" };

export interface QuestionnaireKeybindings {
  matches(data: string, name: string): boolean;
}

// Confirm has two semantic sources: `tui.select.confirm` (the select-list default)
// and `tui.input.submit` (the user's "send" key). A Slack-style configuration folds
// `enter` into `tui.input.newLine` and moves submit elsewhere (e.g. `ctrl+enter`);
// the newline checks below stay first, so without the submit source every confirm
// branch would be shadowed by the collision and no key could confirm (#156). With
// pi defaults both names resolve to `enter`, so matching either is equivalent.
function isConfirm(kb: QuestionnaireKeybindings, data: string): boolean {
  return kb.matches(data, KEYBIND_CONFIRM) || kb.matches(data, KEYBIND_SUBMIT);
}

export function wrapTab(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index % total) + total) % total;
}

function totalTabs(runtime: QuestionnaireRuntime): number {
  return runtime.isMulti ? runtime.questions.length + 1 : 1;
}

function computeAutoAdvanceTab(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): number | undefined {
  if (!runtime.isMulti) return undefined;
  if (state.currentTab < runtime.questions.length - 1) return state.currentTab + 1;
  return runtime.questions.length;
}

/**
 * Index used for the "Type something." row inside `multiSelectChecked`. The row
 * sits at `options.length` in the item list, so its checkbox reuses the same
 * numeric slot. Options can never reach this index (they span 0..length-1), so
 * there is no collision.
 */
export function otherCheckboxIndex(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): number {
  const q = runtime.questions[state.currentTab];
  return q ? q.options.length : 0;
}

/**
 * Build the committed answer for one question tab from the live state.
 *
 * Single-select: the focused row wins — an option row contributes its label,
 * the "other" row contributes the input buffer (possibly empty = explicit
 * "no input"). Multi-select: every checked option label, plus the input
 * buffer when the "other" row is checked and holds text.
 */
function buildAnswer(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionAnswer | null {
  const q = runtime.questions[state.currentTab];
  if (!q) return null;

  if (q.multiSelect) {
    const selected: string[] = [];
    for (let i = 0; i < q.options.length; i++) {
      if (state.multiSelectChecked.has(i)) {
        const label = q.options[i]?.label;
        if (typeof label === "string") selected.push(label);
      }
    }
    if (state.multiSelectChecked.has(q.options.length)) {
      const text = runtime.inputBuffer;
      if (text.length > 0) selected.push(text);
    }
    return { questionIndex: state.currentTab, question: q.question, selected };
  }

  const item = runtime.currentItem;
  if (!item) return null;
  if (item.kind === "other") {
    const text = state.inputMode
      ? runtime.inputBuffer
      : (state.customDraftsByTab.get(state.currentTab) ?? "");
    return {
      questionIndex: state.currentTab,
      question: q.question,
      selected: text.length > 0 ? [text] : [],
    };
  }
  return { questionIndex: state.currentTab, question: q.question, selected: [item.label] };
}

function tabSwitchAction(
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction | null {
  if (!runtime.isMulti) return null;
  const total = totalTabs(runtime);
  if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
    return { kind: "tab_switch", nextTab: wrapTab(state.currentTab + 1, total) };
  }
  if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
    return { kind: "tab_switch", nextTab: wrapTab(state.currentTab - 1, total) };
  }
  return null;
}

// DOWN at the last item wraps to the first (cycle through [option0, …, optionLast]).
function nextNavOnDown(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  return {
    kind: "nav",
    nextIndex: wrapTab(state.optionIndex + 1, Math.max(1, runtime.items.length)),
    inputValue: runtime.inputBuffer,
  };
}

// UP at the first item wraps to the last (symmetric with nextNavOnDown).
function prevNavOnUp(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  return {
    kind: "nav",
    nextIndex: wrapTab(state.optionIndex - 1, Math.max(1, runtime.items.length)),
    inputValue: runtime.inputBuffer,
  };
}

// Collapsed-mode lockout: while collapsed, swallow every keystroke except cancel so
// the user can read the now-uncovered transcript without accidentally mutating
// answers or notes. The collapse toggle itself is already handled above.
function routeCollapsed(kb: QuestionnaireKeybindings, data: string): QuestionnaireAction {
  if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
  return { kind: "ignore" };
}

function routeNotesMode(kb: QuestionnaireKeybindings, data: string): QuestionnaireAction {
  if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "notes_exit" };
  if (kb.matches(data, KEYBIND_NEW_LINE)) return { kind: "notes_forward", data };
  if (isConfirm(kb, data)) return { kind: "notes_exit" };
  return { kind: "notes_forward", data };
}

function routeInputMode(
  kb: QuestionnaireKeybindings,
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  // Newline takes precedence over confirmation if a user configuration binds
  // the same physical key to both semantic actions.
  if (kb.matches(data, KEYBIND_NEW_LINE)) return { kind: "ignore" };
  if (isConfirm(kb, data)) {
    const q = runtime.questions[state.currentTab];
    if (q?.multiSelect) {
      // Multi-select: Enter exits the editor and checks the "other" row —
      // the text becomes part of the pending selection, committed later.
      return { kind: "edit_exit", commit: true, draft: runtime.inputBuffer };
    }
    const answer = buildAnswer(state, runtime);
    if (!answer) return { kind: "ignore" };
    return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
  }
  // Treat Pi's Ctrl+U line-kill binding as an explicit whole-draft clear,
  // independent of the current cursor position.
  if (kb.matches(data, KEYBIND_CLEAR)) return { kind: "input_clear" };
  if (kb.matches(data, KEYBIND_EXTERNAL_EDITOR))
    return { kind: "input_edit", value: runtime.inputBuffer };
  if (kb.matches(data, KEYBIND_CANCEL)) {
    // Esc closes the innermost layer first: the inline editor (keeping the
    // draft, checkbox untouched) — the questionnaire only cancels once the
    // editor is closed (inputMode false on the next dispatch).
    return { kind: "edit_exit", commit: false, draft: runtime.inputBuffer };
  }
  if (kb.matches(data, KEYBIND_EDITOR_UP) && runtime.canMoveInputUp) return { kind: "ignore" };
  if (kb.matches(data, KEYBIND_EDITOR_DOWN) && runtime.canMoveInputDown) return { kind: "ignore" };
  if (kb.matches(data, KEYBIND_UP)) return prevNavOnUp(state, runtime);
  if (kb.matches(data, KEYBIND_DOWN)) return nextNavOnDown(state, runtime);
  return { kind: "ignore" };
}

function routeSubmitTab(
  kb: QuestionnaireKeybindings,
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
  const tab = tabSwitchAction(data, state, runtime);
  if (tab) return tab;
  if (kb.matches(data, KEYBIND_UP) || kb.matches(data, KEYBIND_DOWN)) {
    const delta = kb.matches(data, KEYBIND_DOWN) ? 1 : -1;
    const next = wrapTab(state.submitChoiceIndex + delta, 2);
    return { kind: "submit_nav", nextIndex: (next === 1 ? 1 : 0) as 0 | 1 };
  }
  if (isConfirm(kb, data)) {
    // Submit always submits; Cancel always cancels. Partial answers flow through
    // `orderedAnswers()` in the host.
    return state.submitChoiceIndex === 1 ? { kind: "cancel" } : { kind: "submit" };
  }
  // Global note: `n` on the Submit tab opens the notes editor scoped to the whole
  // questionnaire at the pseudo-index (`questions.length` in notesByTab).
  if (data === NOTES_ACTIVATE_KEY) {
    return { kind: "notes_enter" };
  }
  return { kind: "ignore" };
}

function routeMultiSelectTab(
  kb: QuestionnaireKeybindings,
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  const focusedKind = runtime.currentItem?.kind;
  const focusedMeta = focusedKind ? ROW_INTENT_META[focusedKind] : undefined;
  // Space toggles the focused row's checkbox, including the "Type something."
  // row — its checkbox controls whether the typed text joins `selected`.
  if (data === SPACE_KEY) {
    if (focusedMeta?.blocksMultiToggle) return { kind: "ignore" };
    return { kind: "toggle", index: state.optionIndex };
  }
  if (isConfirm(kb, data)) {
    // Enter on the "Type something." row enters the inline editor; the commit
    // happens on edit_exit (Enter again / Esc). On option rows Enter commits
    // the question with everything currently checked.
    if (focusedMeta?.activatesInputMode) return { kind: "edit_enter" };
    const answer = buildAnswer(state, runtime);
    if (!answer) return { kind: "ignore" };
    return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
  }
  if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
  return { kind: "ignore" };
}

function routeSingleSelectTab(
  kb: QuestionnaireKeybindings,
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  if (isConfirm(kb, data)) {
    const answer = buildAnswer(state, runtime);
    if (!answer) return { kind: "ignore" };
    return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
  }
  if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
  return { kind: "ignore" };
}

export function routeKey(
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  const kb = runtime.keybindings;

  // Collapse/expand toggle is a UI-level affordance — intercepted at the top so it
  // works from every inner state (notes, inputMode, submit tab, multi-select)
  // without reaching any branch that would otherwise consume the keystroke.
  // Treat a missing/non-string key as disabled. The "off" literal is deliberate:
  // loader graph) into this pure module for a string that cannot change.
  if (
    typeof runtime.collapseKey === "string" &&
    runtime.collapseKey !== "off" &&
    matchesKey(data, runtime.collapseKey as Parameters<typeof matchesKey>[1])
  ) {
    return { kind: "toggle_collapsed" };
  }

  if (state.collapsed) return routeCollapsed(kb, data);
  if (state.notesVisible) return routeNotesMode(kb, data);
  if (state.inputMode) return routeInputMode(kb, data, state, runtime);
  if (runtime.isMulti && state.currentTab === runtime.questions.length) {
    return routeSubmitTab(kb, data, state, runtime);
  }

  const tab = tabSwitchAction(data, state, runtime);
  if (tab) return tab;

  const q = runtime.questions[state.currentTab];
  if (!q) return { kind: "ignore" };

  // Universal `n` activation: the notes editor opens on every question tab.
  // The blocks above already swallow `n` when it should NOT reach here —
  // notesVisible forwards to the notes Input, inputMode forwards to the inline
  // Input, and tabSwitchAction ignores it.
  if (data === NOTES_ACTIVATE_KEY) {
    return { kind: "notes_enter" };
  }

  if (kb.matches(data, KEYBIND_UP)) {
    return prevNavOnUp(state, runtime);
  }
  if (kb.matches(data, KEYBIND_DOWN)) {
    return nextNavOnDown(state, runtime);
  }

  if (q.multiSelect) return routeMultiSelectTab(kb, data, state, runtime);
  return routeSingleSelectTab(kb, data, state, runtime);
}
