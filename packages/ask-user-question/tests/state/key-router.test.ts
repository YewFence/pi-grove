import { describe, expect, it } from "vitest";
import type { QuestionAnswer, QuestionData } from "../../src/tool/types.js";
import type { WrappingSelectItem } from "../../src/view/components/wrapping-select.js";
import { routeKey, wrapTab } from "../../src/state/key-router.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "../../src/state/state.js";

const KEY = {
  UP: "tui.select.up",
  DOWN: "tui.select.down",
  CONFIRM: "tui.select.confirm",
  SUBMIT: "tui.input.submit",
  CANCEL: "tui.select.cancel",
  NEW_LINE: "tui.input.newLine",
  EDITOR_UP: "tui.editor.cursorUp",
  EDITOR_DOWN: "tui.editor.cursorDown",
  CLEAR: "tui.editor.deleteToLineStart",
  EXTERNAL_EDITOR: "app.editor.external",
};
const sentinel = (name: string) => `<KEY:${name}>`;
const keybindings = { matches: (data: string, name: string) => data === sentinel(name) };

const BYTE_TAB = "\t";
const BYTE_SHIFT_TAB = "\x1b[Z";
const BYTE_RIGHT = "\x1b[C";
const BYTE_LEFT = "\x1b[D";
const BYTE_SPACE = " ";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
  return {
    question: over.question ?? "Pick one",
    header: over.header ?? "H",
    options: over.options ?? [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
      { label: "C", description: "c" },
    ],
    multiSelect: over.multiSelect,
  };
}

function makeAnswer(over: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return {
    questionIndex: over.questionIndex ?? 0,
    question: over.question ?? "q",
    selected: over.selected ?? ["A"],
  };
}

function makeState(over: Partial<QuestionnaireState> = {}): QuestionnaireState {
  return {
    currentTab: 0,
    optionIndex: 0,
    inputMode: false,
    notesVisible: false,
    answers: new Map<number, QuestionAnswer>(),
    multiSelectChecked: new Set<number>(),
    customDraftsByTab: new Map<number, string>(),
    notesByTab: new Map<number, string>(),
    submitChoiceIndex: 0,
    notesDraft: "",
    collapsed: false,
    ...over,
  };
}

function makeRuntime(over: Partial<QuestionnaireRuntime> = {}): QuestionnaireRuntime {
  const questions = over.questions ?? [makeQuestion(), makeQuestion()];
  const items: WrappingSelectItem[] = over.items
    ? [...over.items]
    : questions[0]!.options.map((o) => ({ kind: "option" as const, label: o.label }));
  return {
    keybindings,
    inputBuffer: "",
    canMoveInputUp: false,
    canMoveInputDown: false,
    questions,
    isMulti: questions.length > 1,
    currentItem: items[0],
    items,
    collapseKey: "ctrl+]",
    ...over,
  };
}

describe("wrapTab", () => {
  it("wraps negative + over-max into [0, total)", () => {
    expect(wrapTab(-1, 3)).toBe(2);
    expect(wrapTab(3, 3)).toBe(0);
    expect(wrapTab(0, 0)).toBe(0);
  });
});

describe("routeKey — nav", () => {
  it("UP from a non-zero index decrements by 1", () => {
    expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
      kind: "nav",
      nextIndex: 1,
      inputValue: "",
    });
  });
  it("DOWN advances by 1", () => {
    expect(routeKey(sentinel(KEY.DOWN), makeState(), makeRuntime())).toEqual({
      kind: "nav",
      nextIndex: 1,
      inputValue: "",
    });
  });
  it("DOWN at the last item wraps to 0 (wrapTab clamp)", () => {
    expect(routeKey(sentinel(KEY.DOWN), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
      kind: "nav",
      nextIndex: 0,
      inputValue: "",
    });
  });
  it("UP at the first item wraps to the last (wrapTab clamp)", () => {
    const runtime = makeRuntime();
    const last = runtime.items.length - 1;
    expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 0 }), runtime)).toEqual({
      kind: "nav",
      nextIndex: last,
      inputValue: "",
    });
  });
});

describe("routeKey — tab_switch", () => {
  it("Tab cycles forward through total tabs (questions + Submit)", () => {
    expect(routeKey(BYTE_TAB, makeState(), makeRuntime())).toEqual({
      kind: "tab_switch",
      nextTab: 1,
    });
  });

  it("Right is an alias for Tab", () => {
    expect(routeKey(BYTE_RIGHT, makeState(), makeRuntime())).toEqual({
      kind: "tab_switch",
      nextTab: 1,
    });
  });

  it("Shift+Tab wraps backward from tab 0 to the Submit tab", () => {
    expect(routeKey(BYTE_SHIFT_TAB, makeState({ currentTab: 0 }), makeRuntime())).toEqual({
      kind: "tab_switch",
      nextTab: 2,
    });
  });

  it("Left is an alias for Shift+Tab", () => {
    expect(routeKey(BYTE_LEFT, makeState({ currentTab: 1 }), makeRuntime())).toEqual({
      kind: "tab_switch",
      nextTab: 0,
    });
  });

  it("Tab is a no-op (returns ignore) in single-question mode", () => {
    expect(
      routeKey(BYTE_TAB, makeState(), makeRuntime({ isMulti: false, questions: [makeQuestion()] })),
    ).toEqual({
      kind: "ignore",
    });
  });
});

describe("routeKey — confirm (single-select)", () => {
  it("emits confirm with autoAdvanceTab pointing to the next tab", () => {
    const action = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 0 }), makeRuntime());
    expect(action).toMatchObject({
      kind: "confirm",
      answer: { questionIndex: 0, selected: ["A"] },
      autoAdvanceTab: 1,
    });
  });

  it("last question -> autoAdvanceTab points at the Submit tab (questions.length)", () => {
    const action = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 1 }), makeRuntime());
    expect(action).toMatchObject({ kind: "confirm", autoAdvanceTab: 2 });
  });

  it("single-question (!isMulti) -> autoAdvanceTab is undefined (dialog submits)", () => {
    const questions = [makeQuestion()];
    const action = routeKey(
      sentinel(KEY.CONFIRM),
      makeState(),
      makeRuntime({
        isMulti: false,
        questions,
        items: [
          { kind: "option", label: "A" },
          { kind: "option", label: "B" },
          { kind: "option", label: "C" },
        ],
      }),
    );
    expect(action).toMatchObject({ kind: "confirm" });
    if (action.kind === "confirm") {
      expect(action.autoAdvanceTab).toBeUndefined();
    }
  });

  it("a key matching only tui.input.submit confirms (second confirm source)", () => {
    const action = routeKey(sentinel(KEY.SUBMIT), makeState({ currentTab: 0 }), makeRuntime());
    expect(action).toMatchObject({
      kind: "confirm",
      answer: { questionIndex: 0, selected: ["A"] },
      autoAdvanceTab: 1,
    });
  });

  it("inline-input mode: Enter confirms with the buffered text as the single selected entry", () => {
    const other: WrappingSelectItem = { kind: "other", label: "Type something." };
    const action = routeKey(
      sentinel(KEY.CONFIRM),
      makeState({ inputMode: true }),
      makeRuntime({ currentItem: other, inputBuffer: "my custom answer" }),
    );
    expect(action.kind).toBe("confirm");
    if (action.kind === "confirm") {
      expect(action.answer.selected).toEqual(["my custom answer"]);
    }
  });
});

describe("routeKey — multiSelect", () => {
  const multiQ = makeQuestion({
    multiSelect: true,
    options: [
      { label: "FE", description: "FE" },
      { label: "BE", description: "BE" },
      { label: "Tests", description: "T" },
    ],
  });
  // 3 options + the "other" row. No Next sentinel — Enter on any option row commits.
  const items: WrappingSelectItem[] = [
    { kind: "option", label: "FE" },
    { kind: "option", label: "BE" },
    { kind: "option", label: "Tests" },
    { kind: "other", label: "Type something." },
  ];

  it("Space emits toggle for the current optionIndex", () => {
    expect(
      routeKey(
        BYTE_SPACE,
        makeState({ optionIndex: 1 }),
        makeRuntime({
          questions: [multiQ],
          isMulti: false,
          items,
          currentItem: items[1],
        }),
      ),
    ).toEqual({ kind: "toggle", index: 1 });
  });

  // Enter on a regular option row commits the question with everything currently
  // checked (no Next sentinel, no toggle semantics for Enter).
  it("Enter on a regular row emits confirm with selected labels in option order", () => {
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({ optionIndex: 1, multiSelectChecked: new Set([2, 0]) }),
        makeRuntime({
          questions: [multiQ],
          isMulti: false,
          items,
          currentItem: items[1],
        }),
      ),
    ).toMatchObject({
      kind: "confirm",
      answer: { selected: ["FE", "Tests"] },
      autoAdvanceTab: undefined,
    });
  });

  // Space on the "other" row toggles its checkbox (so its text joins the selection).
  it("Space on the 'Type something.' row emits toggle for its index", () => {
    expect(
      routeKey(
        BYTE_SPACE,
        makeState({ optionIndex: 3 }),
        makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
      ),
    ).toEqual({ kind: "toggle", index: 3 });
  });

  // Enter on the "other" row enters the inline editor rather than committing.
  it("Enter on the 'Type something.' row (not in inputMode) emits edit_enter", () => {
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({ optionIndex: 3 }),
        makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
      ),
    ).toEqual({ kind: "edit_enter" });
  });

  it("multi-question multi-select on tab 0: Enter carries autoAdvanceTab=1", () => {
    const action = routeKey(
      sentinel(KEY.CONFIRM),
      makeState({ currentTab: 0, optionIndex: 1, multiSelectChecked: new Set([0]) }),
      makeRuntime({
        questions: [multiQ, makeQuestion()],
        isMulti: true,
        items,
        currentItem: items[1],
      }),
    );
    expect(action.kind).toBe("confirm");
    if (action.kind === "confirm") expect(action.autoAdvanceTab).toBe(1);
  });

  it("multi-question multi-select on last tab: Enter carries autoAdvanceTab=questions.length (Submit)", () => {
    const action = routeKey(
      sentinel(KEY.CONFIRM),
      makeState({ currentTab: 1, optionIndex: 1, multiSelectChecked: new Set([0]) }),
      makeRuntime({
        questions: [makeQuestion(), multiQ],
        isMulti: true,
        items,
        currentItem: items[1],
      }),
    );
    expect(action.kind).toBe("confirm");
    if (action.kind === "confirm") expect(action.autoAdvanceTab).toBe(2);
  });

  it("Space does NOT emit toggle on a single-select question", () => {
    expect(routeKey(BYTE_SPACE, makeState(), makeRuntime())).toEqual({ kind: "ignore" });
  });

  // Committing with the "other" row checked and non-empty text folds the text into
  // `selected` alongside the checked option labels.
  it("Enter commits options + the other-row text when the other row is checked", () => {
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({
          optionIndex: 1,
          multiSelectChecked: new Set([0, 3]),
          customDraftsByTab: new Map([[0, "extra note"]]),
        }),
        makeRuntime({
          questions: [multiQ],
          isMulti: false,
          items,
          currentItem: items[1],
          inputBuffer: "extra note",
        }),
      ),
    ).toMatchObject({ kind: "confirm", answer: { selected: ["FE", "extra note"] } });
  });

  // Committing with the other row checked but empty text drops the empty entry.
  it("Enter with the other row checked but empty text omits it from selected", () => {
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({ optionIndex: 1, multiSelectChecked: new Set([0, 3]) }),
        makeRuntime({
          questions: [multiQ],
          isMulti: false,
          items,
          currentItem: items[1],
          inputBuffer: "",
        }),
      ),
    ).toMatchObject({ kind: "confirm", answer: { selected: ["FE"] } });
  });
});

describe("routeKey — cancel + submit", () => {
  it("Esc cancels the entire questionnaire from any tab", () => {
    expect(routeKey(sentinel(KEY.CANCEL), makeState(), makeRuntime())).toEqual({ kind: "cancel" });
    expect(routeKey(sentinel(KEY.CANCEL), makeState({ currentTab: 2 }), makeRuntime())).toEqual({
      kind: "cancel",
    });
  });

  it("Submit tab + Enter on Submit row -> submit", () => {
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({
          currentTab: 2,
          submitChoiceIndex: 0,
          answers: new Map([
            [0, makeAnswer({ questionIndex: 0 })],
            [1, makeAnswer({ questionIndex: 1 })],
          ]),
        }),
        makeRuntime(),
      ),
    ).toEqual({ kind: "submit" });
  });

  it("Submit tab + Enter on Submit row when not allAnswered -> submit (partial)", () => {
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({
          currentTab: 2,
          submitChoiceIndex: 0,
          answers: new Map([[0, makeAnswer({ questionIndex: 0 })]]),
        }),
        makeRuntime(),
      ),
    ).toEqual({ kind: "submit" });
  });

  it("Submit tab + DOWN -> submit_nav nextIndex=1", () => {
    expect(
      routeKey(
        sentinel(KEY.DOWN),
        makeState({ currentTab: 2, submitChoiceIndex: 0 }),
        makeRuntime(),
      ),
    ).toEqual({
      kind: "submit_nav",
      nextIndex: 1,
    });
  });

  it("Submit tab + UP wraps from 0 to 1", () => {
    expect(
      routeKey(sentinel(KEY.UP), makeState({ currentTab: 2, submitChoiceIndex: 0 }), makeRuntime()),
    ).toEqual({
      kind: "submit_nav",
      nextIndex: 1,
    });
  });

  it("Submit tab + DOWN from index 1 wraps to 0", () => {
    expect(
      routeKey(
        sentinel(KEY.DOWN),
        makeState({ currentTab: 2, submitChoiceIndex: 1 }),
        makeRuntime(),
      ),
    ).toEqual({
      kind: "submit_nav",
      nextIndex: 0,
    });
  });

  it("Submit tab + Enter on Cancel row (index 1) when complete -> cancel", () => {
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({
          currentTab: 2,
          submitChoiceIndex: 1,
          answers: new Map([
            [0, makeAnswer({ questionIndex: 0 })],
            [1, makeAnswer({ questionIndex: 1 })],
          ]),
        }),
        makeRuntime(),
      ),
    ).toEqual({ kind: "cancel" });
  });

  it("Submit tab + Enter on Cancel row (index 1) when incomplete -> cancel", () => {
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({ currentTab: 2, submitChoiceIndex: 1 }),
        makeRuntime(),
      ),
    ).toEqual({ kind: "cancel" });
  });
});

describe("routeKey — notes", () => {
  it("'n' emits notes_enter regardless of preview (universal gate)", () => {
    expect(routeKey("n", makeState(), makeRuntime())).toEqual({
      kind: "notes_enter",
    });
  });

  it("'n' emits notes_enter on multiSelect questions even with preview (universal gate)", () => {
    const multiQ = makeQuestion({ multiSelect: true });
    expect(
      routeKey("n", makeState(), makeRuntime({ questions: [multiQ, makeQuestion()] })),
    ).toEqual({
      kind: "notes_enter",
    });
  });

  it("'n' emits notes_enter when the multi-select 'Type something.' row is focused", () => {
    const multiQ = makeQuestion({
      multiSelect: true,
      options: [
        { label: "FE", description: "FE" },
        { label: "BE", description: "BE" },
        { label: "Tests", description: "T" },
      ],
    });
    const items: WrappingSelectItem[] = [
      { kind: "option", label: "FE" },
      { kind: "option", label: "BE" },
      { kind: "option", label: "Tests" },
      { kind: "other", label: "Type something." },
    ];
    expect(
      routeKey(
        "n",
        makeState({ optionIndex: 3 }),
        makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
      ),
    ).toEqual({ kind: "notes_enter" });
  });

  it("notesMode: Esc -> notes_exit", () => {
    expect(
      routeKey(sentinel(KEY.CANCEL), makeState({ notesVisible: true }), makeRuntime()),
    ).toEqual({
      kind: "notes_exit",
    });
  });

  it("notesMode: Enter -> notes_exit (save + return to options)", () => {
    expect(
      routeKey(sentinel(KEY.CONFIRM), makeState({ notesVisible: true }), makeRuntime()),
    ).toEqual({
      kind: "notes_exit",
    });
  });

  it("notesMode: Tab byte emits notes_forward (any non-Esc/Enter key forwards to the Input)", () => {
    expect(routeKey(BYTE_TAB, makeState({ notesVisible: true }), makeRuntime())).toEqual({
      kind: "notes_forward",
      data: BYTE_TAB,
    });
  });

  it("notesMode: arbitrary printable byte emits notes_forward (single dispatch path)", () => {
    expect(routeKey("a", makeState({ notesVisible: true }), makeRuntime())).toEqual({
      kind: "notes_forward",
      data: "a",
    });
  });

  it("notesMode: configured newline is forwarded instead of closing the editor", () => {
    const data = sentinel(KEY.NEW_LINE);
    expect(routeKey(data, makeState({ notesVisible: true }), makeRuntime())).toEqual({
      kind: "notes_forward",
      data,
    });
  });
});

describe("routeKey — global note on the Submit tab", () => {
  const submitTab = (over: Partial<QuestionnaireState> = {}) =>
    makeState({ currentTab: 2, notesVisible: false, ...over });

  it("'n' with the editor closed emits notes_enter at the pseudo-index", () => {
    expect(routeKey("n", submitTab(), makeRuntime())).toEqual({ kind: "notes_enter" });
  });

  it("while open, the Tab byte forwards to the notes editor — NOT tab_switch", () => {
    expect(routeKey(BYTE_TAB, submitTab({ notesVisible: true }), makeRuntime())).toEqual({
      kind: "notes_forward",
      data: BYTE_TAB,
    });
  });

  it("while open, a printable byte forwards into the editor (typing captured)", () => {
    expect(routeKey("z", submitTab({ notesVisible: true }), makeRuntime())).toEqual({
      kind: "notes_forward",
      data: "z",
    });
  });

  it("while open, a second 'n' forwards as a literal character instead of re-entering notes", () => {
    expect(routeKey("n", submitTab({ notesVisible: true }), makeRuntime())).toEqual({
      kind: "notes_forward",
      data: "n",
    });
  });

  it("while open, Esc commits the note (notes_exit)", () => {
    expect(
      routeKey(sentinel(KEY.CANCEL), submitTab({ notesVisible: true }), makeRuntime()),
    ).toEqual({
      kind: "notes_exit",
    });
  });

  it("while open, Enter commits the note (notes_exit) — it does NOT submit", () => {
    expect(
      routeKey(sentinel(KEY.CONFIRM), submitTab({ notesVisible: true }), makeRuntime()),
    ).toEqual({
      kind: "notes_exit",
    });
  });

  it("with the editor closed, Enter still submits/cancels per submitChoiceIndex (the n branch shadows nothing)", () => {
    expect(
      routeKey(sentinel(KEY.CONFIRM), submitTab({ submitChoiceIndex: 0 }), makeRuntime()),
    ).toEqual({
      kind: "submit",
    });
    expect(
      routeKey(sentinel(KEY.CONFIRM), submitTab({ submitChoiceIndex: 1 }), makeRuntime()),
    ).toEqual({
      kind: "cancel",
    });
  });
});

describe("routeKey — inputMode (Type something)", () => {
  const other: WrappingSelectItem = { kind: "other", label: "Type something." };

  it("Tab byte is ignored under inputMode", () => {
    expect(
      routeKey(BYTE_TAB, makeState({ inputMode: true }), makeRuntime({ currentItem: other })),
    ).toEqual({
      kind: "ignore",
    });
  });

  it("printable bytes return ignore (dialog forwards to inlineInput.handleInput)", () => {
    expect(
      routeKey("x", makeState({ inputMode: true }), makeRuntime({ currentItem: other })),
    ).toEqual({
      kind: "ignore",
    });
  });

  it("configured newline is forwarded to the multiline editor", () => {
    expect(
      routeKey(
        sentinel(KEY.NEW_LINE),
        makeState({ inputMode: true }),
        makeRuntime({ currentItem: other }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("forwards vertical editor movement while the cursor is between logical lines", () => {
    const editing = makeState({ inputMode: true, optionIndex: 1 });
    expect(
      routeKey(
        sentinel(KEY.EDITOR_UP),
        editing,
        makeRuntime({ currentItem: other, canMoveInputUp: true, canMoveInputDown: true }),
      ),
    ).toEqual({ kind: "ignore" });
    expect(
      routeKey(
        sentinel(KEY.EDITOR_DOWN),
        editing,
        makeRuntime({ currentItem: other, canMoveInputUp: true, canMoveInputDown: true }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("'n' under inputMode returns ignore (types a literal 'n'), NOT notes_enter", () => {
    expect(
      routeKey("n", makeState({ inputMode: true }), makeRuntime({ currentItem: other })),
    ).toEqual({
      kind: "ignore",
    });
  });

  it("Pi's Ctrl+U line-kill binding clears the whole custom answer", () => {
    expect(
      routeKey(
        sentinel(KEY.CLEAR),
        makeState({ inputMode: true }),
        makeRuntime({ currentItem: other }),
      ),
    ).toEqual({ kind: "input_clear" });
  });

  it("the app.editor.external binding opens the editor with the current draft", () => {
    expect(
      routeKey(
        sentinel(KEY.EXTERNAL_EDITOR),
        makeState({ inputMode: true }),
        makeRuntime({ currentItem: other, inputBuffer: "draft" }),
      ),
    ).toEqual({ kind: "input_edit", value: "draft" });
  });

  // Single-select inputMode: Esc also closes the editor first (focus falls back
  // to the first option row) — the questionnaire only cancels once the editor is closed.
  it("Esc in single-select inputMode emits edit_exit (no commit), not cancel", () => {
    const single = makeQuestion();
    expect(
      routeKey(
        sentinel(KEY.CANCEL),
        makeState({ inputMode: true }),
        makeRuntime({ currentItem: other, questions: [single], isMulti: false }),
      ),
    ).toEqual({ kind: "edit_exit", commit: false, draft: "" });
  });

  // Multi-select inputMode: Enter exits the editor and checks the "other" row,
  // carrying the live buffer in `draft`.
  it("Enter in multi-select inputMode emits edit_exit (commit) with the live draft", () => {
    const multiQ = makeQuestion({ multiSelect: true });
    expect(
      routeKey(
        sentinel(KEY.CONFIRM),
        makeState({ inputMode: true, optionIndex: 2 }),
        makeRuntime({
          questions: [multiQ],
          isMulti: false,
          currentItem: other,
          inputBuffer: "typed",
        }),
      ),
    ).toEqual({ kind: "edit_exit", commit: true, draft: "typed" });
  });

  // Multi-select inputMode: Esc exits the editor WITHOUT checking the row.
  it("Esc in multi-select inputMode emits edit_exit (no commit) instead of cancel", () => {
    const multiQ = makeQuestion({ multiSelect: true });
    expect(
      routeKey(
        sentinel(KEY.CANCEL),
        makeState({ inputMode: true, optionIndex: 2 }),
        makeRuntime({ questions: [multiQ], isMulti: false, currentItem: other }),
      ),
    ).toEqual({ kind: "edit_exit", commit: false, draft: "" });
  });
});

describe("routeKey — remapped submit key as the confirm source (#156)", () => {
  const REMAPPED_ENTER = "<REMAPPED:ENTER>";
  const REMAPPED_CTRL_ENTER = "<REMAPPED:CTRL_ENTER>";
  const remapped = {
    matches(data: string, name: string): boolean {
      switch (name) {
        case KEY.SUBMIT:
          return data === REMAPPED_CTRL_ENTER;
        case KEY.NEW_LINE:
          return data === REMAPPED_ENTER;
        case KEY.CONFIRM:
          return data === REMAPPED_ENTER;
        default:
          return false;
      }
    },
  };
  const other: WrappingSelectItem = { kind: "other", label: "Type something." };

  it("inputMode: Enter is consumed as a newline (collision resolves to newline)", () => {
    expect(
      routeKey(
        REMAPPED_ENTER,
        makeState({ inputMode: true }),
        makeRuntime({ keybindings: remapped, currentItem: other }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("inputMode: the submit key confirms with the buffered text instead of falling through to the editor", () => {
    const action = routeKey(
      REMAPPED_CTRL_ENTER,
      makeState({ inputMode: true }),
      makeRuntime({ keybindings: remapped, currentItem: other, inputBuffer: "typed answer" }),
    );
    expect(action).toMatchObject({ kind: "confirm", answer: { selected: ["typed answer"] } });
  });

  it("notes: Enter forwards as a newline; the submit key exits the notes editor", () => {
    expect(
      routeKey(
        REMAPPED_ENTER,
        makeState({ notesVisible: true }),
        makeRuntime({ keybindings: remapped }),
      ),
    ).toEqual({ kind: "notes_forward", data: REMAPPED_ENTER });
    expect(
      routeKey(
        REMAPPED_CTRL_ENTER,
        makeState({ notesVisible: true }),
        makeRuntime({ keybindings: remapped }),
      ),
    ).toEqual({ kind: "notes_exit" });
  });

  it("single-select option row: the submit key confirms", () => {
    expect(
      routeKey(
        REMAPPED_CTRL_ENTER,
        makeState({ currentTab: 0 }),
        makeRuntime({ keybindings: remapped }),
      ),
    ).toMatchObject({ kind: "confirm", answer: { selected: ["A"] } });
  });

  it("Submit tab: the submit key submits the questionnaire", () => {
    expect(
      routeKey(
        REMAPPED_CTRL_ENTER,
        makeState({ currentTab: 2, submitChoiceIndex: 0 }),
        makeRuntime({ keybindings: remapped }),
      ),
    ).toEqual({ kind: "submit" });
  });

  it("multi-select: the submit key commits on a regular row (matches Enter)", () => {
    const multiQ = makeQuestion({
      multiSelect: true,
      options: [
        { label: "FE", description: "FE" },
        { label: "BE", description: "BE" },
      ],
    });
    const items: WrappingSelectItem[] = [
      { kind: "option", label: "FE" },
      { kind: "option", label: "BE" },
      { kind: "other", label: "Type something." },
    ];
    expect(
      routeKey(
        REMAPPED_CTRL_ENTER,
        makeState({ optionIndex: 1, multiSelectChecked: new Set([0]) }),
        makeRuntime({
          keybindings: remapped,
          questions: [multiQ],
          isMulti: false,
          items,
          currentItem: items[1],
        }),
      ),
    ).toMatchObject({ kind: "confirm", answer: { selected: ["FE"] }, autoAdvanceTab: undefined });
  });
});

describe("routeKey — collapse/expand (Ctrl+] toggle + collapsed-mode lockout)", () => {
  const BYTE_CTRL_RBRACKET = "\x1d";

  it("Ctrl+] emits toggle_collapsed from the default question state", () => {
    expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), makeRuntime())).toEqual({
      kind: "toggle_collapsed",
    });
  });

  it("Ctrl+] emits toggle_collapsed even while notesVisible (the notes branch never sees the key)", () => {
    expect(routeKey(BYTE_CTRL_RBRACKET, makeState({ notesVisible: true }), makeRuntime())).toEqual({
      kind: "toggle_collapsed",
    });
  });

  it("Ctrl+] emits toggle_collapsed even when already collapsed (expand round-trip)", () => {
    expect(routeKey(BYTE_CTRL_RBRACKET, makeState({ collapsed: true }), makeRuntime())).toEqual({
      kind: "toggle_collapsed",
    });
  });

  it("while collapsed, Esc maps to cancel (the documented escape hatch in the one-line footer)", () => {
    expect(routeKey(sentinel(KEY.CANCEL), makeState({ collapsed: true }), makeRuntime())).toEqual({
      kind: "cancel",
    });
  });

  it("while collapsed, navigation keys are swallowed as ignore (no state mutation behind the one-line footer)", () => {
    expect(
      routeKey(sentinel(KEY.UP), makeState({ collapsed: true, optionIndex: 2 }), makeRuntime()),
    ).toEqual({
      kind: "ignore",
    });
    expect(routeKey(sentinel(KEY.DOWN), makeState({ collapsed: true }), makeRuntime())).toEqual({
      kind: "ignore",
    });
    expect(routeKey(sentinel(KEY.CONFIRM), makeState({ collapsed: true }), makeRuntime())).toEqual({
      kind: "ignore",
    });
    expect(routeKey(BYTE_TAB, makeState({ collapsed: true }), makeRuntime())).toEqual({
      kind: "ignore",
    });
  });

  it("while collapsed, the notes-forward and toggle branches are unreachable (lockout precedes them)", () => {
    expect(
      routeKey("x", makeState({ collapsed: true, notesVisible: true }), makeRuntime()),
    ).toEqual({
      kind: "ignore",
    });
    expect(
      routeKey(
        BYTE_SPACE,
        makeState({ collapsed: true }),
        makeRuntime({ questions: [makeQuestion({ multiSelect: true })] }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("uses the runtime's collapseKey for the toggle (default `ctrl+]`, configurable for non-US layouts)", () => {
    const BYTE_ALT_O = "\x1bo";
    expect(routeKey(BYTE_ALT_O, makeState(), makeRuntime({ collapseKey: "alt+o" }))).toEqual({
      kind: "toggle_collapsed",
    });
    expect(routeKey("\x1d", makeState(), makeRuntime({ collapseKey: "alt+o" }))).toEqual({
      kind: "ignore",
    });
  });
  it("`collapseKey: 'off'` disables the toggle entirely (the key is never matched)", () => {
    const runtime = makeRuntime({ collapseKey: "off" });
    expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), runtime)).not.toEqual({
      kind: "toggle_collapsed",
    });
  });

  it("treats a missing collapseKey as disabled instead of throwing after an in-process package update", () => {
    const runtime = makeRuntime() as unknown as { collapseKey?: string };
    delete runtime.collapseKey;

    expect(() =>
      routeKey(BYTE_CTRL_RBRACKET, makeState(), runtime as QuestionnaireRuntime),
    ).not.toThrow();
    expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), runtime as QuestionnaireRuntime)).toEqual({
      kind: "ignore",
    });
  });
});
