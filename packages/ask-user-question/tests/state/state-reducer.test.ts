import { describe, expect, it } from "vitest";
import {
  itemsRegular,
  itemsWithOther,
  makeApplyContext as makeCtx,
  makeQuestion,
  makeQuestionnaireState as makeState,
} from "../helpers/test-fixtures.js";
import type { QuestionAnswer } from "../../src/tool/types.js";
import type { QuestionnaireAction } from "../../src/state/key-router.js";
import { type Effect, reduce } from "../../src/state/state-reducer.js";

describe("reduce — nav", () => {
  it("regular nav keeps the active draft buffer intact", () => {
    const r = reduce(makeState(), { kind: "nav", nextIndex: 1, inputValue: "" }, makeCtx());
    expect(r.state.optionIndex).toBe(1);
    expect(r.state.inputMode).toBe(false);
    expect(r.effects).toEqual([]);
  });

  it("nav onto kind:'other' row auto-enters inputMode on a single-select tab and restores the buffer", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["Hello"] }],
    ]);
    const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
    const r = reduce(makeState({ answers }), { kind: "nav", nextIndex: 2, inputValue: "" }, ctx);
    expect(r.state.inputMode).toBe(true);
    expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "Hello" }]);
  });

  it("nav onto kind:'other' row on a multi-select tab does NOT auto-enter inputMode", () => {
    const ctx = makeCtx({
      questions: [makeQuestion({ multiSelect: true })],
      itemsByTab: [itemsWithOther],
    });
    const r = reduce(makeState(), { kind: "nav", nextIndex: 2, inputValue: "" }, ctx);
    expect(r.state.inputMode).toBe(false);
    expect(r.effects).toEqual([]);
  });

  it("nav onto kind:'other' row with no draft resets the buffer", () => {
    const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
    const r = reduce(makeState(), { kind: "nav", nextIndex: 2, inputValue: "" }, ctx);
    expect(r.state.inputMode).toBe(true);
    expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "" }]);
  });

  it("nav back onto kind:'other' restores the in-flight draft ahead of a confirmed answer", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["confirmed"] }],
    ]);
    const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
    const state = makeState({ answers, customDraftsByTab: new Map([[0, "draft"]]) });
    const r = reduce(state, { kind: "nav", nextIndex: 2, inputValue: "" }, ctx);
    expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "draft" }]);
  });

  it("an explicitly cleared draft does not resurrect a confirmed custom answer", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["confirmed"] }],
    ]);
    const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
    const state = makeState({ answers, customDraftsByTab: new Map([[0, ""]]) });
    const r = reduce(state, { kind: "nav", nextIndex: 2, inputValue: "" }, ctx);
    expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "" }]);
  });

  it("snapshots the live input value when navigation leaves the custom row", () => {
    const state = makeState({ optionIndex: 2, inputMode: true });
    const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
    const r = reduce(state, { kind: "nav", nextIndex: 1, inputValue: "draft" }, ctx);
    expect(r.state.customDraftsByTab.get(0)).toBe("draft");
  });
});

describe("reduce — tab_switch", () => {
  it("emits set_notes_focused(false) + set_notes_value", () => {
    const r = reduce(
      makeState(),
      { kind: "tab_switch", nextTab: 1 },
      makeCtx({
        questions: [makeQuestion(), makeQuestion()],
        itemsByTab: [itemsRegular, itemsRegular],
      }),
    );
    expect(r.state.currentTab).toBe(1);
    expect(r.state.optionIndex).toBe(0);
    expect(r.state.notesVisible).toBe(false);
    expect(r.effects).toEqual([
      { kind: "set_notes_focused", focused: false },
      { kind: "set_notes_value", value: "" },
      { kind: "set_input_buffer", value: "" },
    ]);
  });

  it("rehydrates the target question's custom draft without leaking the current tab", () => {
    const questions = [makeQuestion(), makeQuestion()];
    const ctx = makeCtx({ questions, itemsByTab: [itemsRegular, itemsRegular] });
    const state = makeState({
      customDraftsByTab: new Map([
        [0, "first"],
        [1, "second"],
      ]),
    });
    const r = reduce(state, { kind: "tab_switch", nextTab: 1 }, ctx);
    expect(r.effects).toContainEqual({ kind: "set_input_buffer", value: "second" });
  });

  it("rehydrates a multi-select custom entry from the committed answer (answer-anchored restore)", () => {
    const questions = [makeQuestion({ multiSelect: true }), makeQuestion()];
    const ctx = makeCtx({ questions, itemsByTab: [itemsWithOther, itemsRegular] });
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["A", "custom text"] }],
    ]);
    const r = reduce(makeState({ answers }), { kind: "tab_switch", nextTab: 0 }, ctx);
    expect(r.effects).toContainEqual({ kind: "set_input_buffer", value: "custom text" });
  });
});

describe("reduce — confirm", () => {
  it("regular option emits done with the answer", () => {
    const action: QuestionnaireAction = {
      kind: "confirm",
      answer: { questionIndex: 0, question: "Pick one", selected: ["A"] },
    };
    const r = reduce(makeState(), action, makeCtx());
    expect(r.state.answers.get(0)?.selected).toEqual(["A"]);
    expect(r.effects).toEqual([
      { kind: "done", result: { answers: [r.state.answers.get(0)!], cancelled: false } },
    ]);
  });

  it("makes the confirmed custom answer authoritative by removing its draft", () => {
    const action: QuestionnaireAction = {
      kind: "confirm",
      answer: { questionIndex: 0, question: "Pick one", selected: ["latest"] },
    };
    const state = makeState({ customDraftsByTab: new Map([[0, "stale"]]) });
    const r = reduce(state, action, makeCtx());
    expect(r.state.customDraftsByTab.has(0)).toBe(false);
    expect(r.state.answers.get(0)?.selected).toEqual(["latest"]);
  });

  it("merges pendingNotes from notesByTab into the confirmed answer", () => {
    const action: QuestionnaireAction = {
      kind: "confirm",
      answer: { questionIndex: 0, question: "Pick one", selected: ["A"] },
    };
    const state = makeState({ notesByTab: new Map([[0, "  side note  "]]) });
    const r = reduce(state, action, makeCtx());
    expect(r.state.answers.get(0)?.notes).toBe("  side note  ");
  });

  it("autoAdvanceTab dispatches a tab_switch result instead of done", () => {
    const action: QuestionnaireAction = {
      kind: "confirm",
      answer: { questionIndex: 0, question: "Pick one", selected: ["A"] },
      autoAdvanceTab: 1,
    };
    const ctx = makeCtx({
      questions: [makeQuestion(), makeQuestion()],
      itemsByTab: [itemsRegular, itemsRegular],
    });
    const r = reduce(makeState(), action, ctx);
    expect(r.state.currentTab).toBe(1);
    expect(r.effects.some((e) => e.kind === "set_notes_focused")).toBe(true);
    expect(r.effects.some((e) => e.kind === "done")).toBe(false);
  });

  it("an empty selection deletes the tab's answer (explicit 'leave unanswered')", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["A"] }],
    ]);
    const action: QuestionnaireAction = {
      kind: "confirm",
      answer: { questionIndex: 0, question: "Pick one", selected: [] },
    };
    const r = reduce(makeState({ answers }), action, makeCtx());
    expect(r.state.answers.has(0)).toBe(false);
  });

  it("confirm with mixed labels + custom text persists both in selected (no mutual exclusion)", () => {
    const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
    const action: QuestionnaireAction = {
      kind: "confirm",
      answer: { questionIndex: 0, question: "Pick one", selected: ["A", "custom text"] },
      autoAdvanceTab: undefined,
    };
    const r = reduce(makeState(), action, ctx);
    expect(r.state.answers.get(0)?.selected).toEqual(["A", "custom text"]);
  });
});

describe("reduce — toggle", () => {
  it("toggles index 0 on then off", () => {
    const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
    const r1 = reduce(makeState(), { kind: "toggle", index: 0 }, ctx);
    expect(r1.state.multiSelectChecked.has(0)).toBe(true);
    const r2 = reduce(r1.state, { kind: "toggle", index: 0 }, ctx);
    expect(r2.state.multiSelectChecked.has(0)).toBe(false);
  });

  it("toggles the other-row index like any option row", () => {
    const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
    const r = reduce(makeState(), { kind: "toggle", index: 2 }, ctx);
    expect(r.state.multiSelectChecked.has(2)).toBe(true);
  });
});

describe("reduce — round-trip property [confirm, tab_switch, tab_switch_back] preserves checked state", () => {
  it("multiSelectChecked is reconstructed from answers on tab-back", () => {
    const questions = [makeQuestion({ multiSelect: true }), makeQuestion()];
    const ctx = makeCtx({ questions, itemsByTab: questions.map(() => itemsRegular) });

    let s = makeState();
    s = reduce(s, { kind: "toggle", index: 0 }, ctx).state;
    s = reduce(s, { kind: "toggle", index: 1 }, ctx).state;
    s = reduce(
      s,
      {
        kind: "confirm",
        answer: { questionIndex: 0, question: "Pick one", selected: ["A", "B"] },
        autoAdvanceTab: 1,
      },
      ctx,
    ).state;
    // Auto-advanced to tab 1 — its checked set is empty (no answer there yet).
    expect(s.currentTab).toBe(1);
    expect([...s.multiSelectChecked]).toEqual([]);

    s = reduce(s, { kind: "tab_switch", nextTab: 1 }, ctx).state;
    expect([...s.multiSelectChecked]).toEqual([]);

    s = reduce(s, { kind: "tab_switch", nextTab: 0 }, ctx).state;
    expect([...s.multiSelectChecked].sort()).toEqual([0, 1]);
  });
});

describe("reduce — cancel/submit", () => {
  it("cancel emits done with cancelled: true", () => {
    const r = reduce(makeState(), { kind: "cancel" }, makeCtx());
    expect(r.effects).toEqual([{ kind: "done", result: { answers: [], cancelled: true } }]);
  });
  it("submit emits done with cancelled: false", () => {
    const r = reduce(makeState(), { kind: "submit" }, makeCtx());
    expect(r.effects).toEqual([{ kind: "done", result: { answers: [], cancelled: false } }]);
  });
});

describe("reduce — global note lift (doneFor)", () => {
  const twoQuestionCtx = makeCtx({
    questions: [makeQuestion(), makeQuestion()],
    itemsByTab: [itemsRegular, itemsRegular],
  });

  it("submit on the Submit tab lifts notesByTab[questions.length] into result.globalNote (strict toEqual)", () => {
    const state = makeState({ currentTab: 2, notesByTab: new Map([[2, "ship it Friday"]]) });
    const r = reduce(state, { kind: "submit" }, twoQuestionCtx);
    expect(r.effects).toEqual([
      { kind: "done", result: { answers: [], cancelled: false, globalNote: "ship it Friday" } },
    ]);
  });

  it("cancel with a committed note still lifts it (attach-on-cancel — no cancelled guard)", () => {
    const state = makeState({ currentTab: 2, notesByTab: new Map([[2, "note survives decline"]]) });
    const r = reduce(state, { kind: "cancel" }, twoQuestionCtx);
    expect(r.effects).toEqual([
      {
        kind: "done",
        result: { answers: [], cancelled: true, globalNote: "note survives decline" },
      },
    ]);
  });

  it("note-free submit/cancel/confirm produce the key absent (never undefined-assigned)", () => {
    const submit = reduce(makeState(), { kind: "submit" }, twoQuestionCtx);
    const cancel = reduce(makeState(), { kind: "cancel" }, twoQuestionCtx);
    const confirm = reduce(
      makeState(),
      { kind: "confirm", answer: { questionIndex: 0, question: "Pick one", selected: ["A"] } },
      twoQuestionCtx,
    );
    for (const r of [submit, cancel, confirm]) {
      const done = r.effects[0] as Extract<Effect, { kind: "done" }>;
      expect(done.kind).toBe("done");
      expect("globalNote" in done.result).toBe(false);
    }
  });

  it("single-question dialog: a per-question note rides answers[0].notes, never globalNote", () => {
    const state = makeState({ notesByTab: new Map([[0, "per-question note"]]) });
    const r = reduce(
      state,
      { kind: "confirm", answer: { questionIndex: 0, question: "Pick one", selected: ["A"] } },
      makeCtx(),
    );
    const done = r.effects[0] as Extract<Effect, { kind: "done" }>;
    expect(done.result.answers[0]?.notes).toBe("per-question note");
    expect("globalNote" in done.result).toBe(false);
  });
});

describe("reduce — notes_enter / notes_exit / notes_forward", () => {
  it("notes_enter seeds state.notesDraft from existing answer.notes and emits set_notes_value", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "q", selected: ["A"], notes: "old note" }],
    ]);
    const r = reduce(makeState({ answers }), { kind: "notes_enter" }, makeCtx());
    expect(r.state.notesVisible).toBe(true);
    expect(r.state.notesDraft).toBe("old note");
    expect(r.effects).toEqual([
      { kind: "set_notes_value", value: "old note" },
      { kind: "set_notes_focused", focused: true },
    ]);
  });

  it("notes_enter seeds notesDraft from notesByTab when the option is not yet confirmed (regression: reopening cleared the note)", () => {
    const state = makeState({ notesByTab: new Map([[0, "pending note"]]) });
    const r = reduce(state, { kind: "notes_enter" }, makeCtx());
    expect(r.state.notesVisible).toBe(true);
    expect(r.state.notesDraft).toBe("pending note");
    expect(r.effects).toEqual([
      { kind: "set_notes_value", value: "pending note" },
      { kind: "set_notes_focused", focused: true },
    ]);
  });

  it("notes_enter prefers notesByTab over a committed answer.notes", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "q", selected: ["A"], notes: "committed" }],
    ]);
    const r = reduce(
      makeState({ answers, notesByTab: new Map([[0, "in-flight edit"]]) }),
      { kind: "notes_enter" },
      makeCtx(),
    );
    expect(r.state.notesDraft).toBe("in-flight edit");
  });

  it("notes_exit with empty notesDraft clears notesByTab + strips answer.notes", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "q", selected: ["A"], notes: "old note" }],
    ]);
    const state = makeState({
      answers,
      notesByTab: new Map([[0, "old note"]]),
      notesVisible: true,
      notesDraft: "",
    });
    const r = reduce(state, { kind: "notes_exit" }, makeCtx());
    expect(r.state.notesVisible).toBe(false);
    expect(r.state.notesByTab.has(0)).toBe(false);
    expect(r.state.answers.get(0)?.notes).toBeUndefined();
  });

  it("notes_exit trims state.notesDraft before persisting", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "q", selected: ["A"] }],
    ]);
    const r = reduce(
      makeState({ answers, notesVisible: true, notesDraft: "  fresh  " }),
      { kind: "notes_exit" },
      makeCtx(),
    );
    expect(r.state.notesByTab.get(0)).toBe("fresh");
    expect(r.state.answers.get(0)?.notes).toBe("fresh");
  });

  it("notes_exit with whitespace-only notesDraft clears notesByTab + strips answer.notes", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "q", selected: ["A"], notes: "old note" }],
    ]);
    const r = reduce(
      makeState({
        answers,
        notesByTab: new Map([[0, "old note"]]),
        notesVisible: true,
        notesDraft: "   ",
      }),
      { kind: "notes_exit" },
      makeCtx(),
    );
    expect(r.state.notesByTab.has(0)).toBe(false);
    expect(r.state.answers.get(0)?.notes).toBeUndefined();
  });

  it("notes_forward emits a single forward_notes_keystroke effect with no state change", () => {
    const s = makeState({ notesVisible: true, notesDraft: "hel" });
    const r = reduce(s, { kind: "notes_forward", data: "l" }, makeCtx());
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([{ kind: "forward_notes_keystroke", data: "l" }]);
  });
});

describe("reduce — custom-input controls", () => {
  it("input_clear clears the headless input buffer and records an explicit empty draft", () => {
    const state = makeState({ inputMode: true, customDraftsByTab: new Map([[0, "draft"]]) });
    const r = reduce(state, { kind: "input_clear" }, makeCtx());
    expect(r.state.customDraftsByTab.get(0)).toBe("");
    expect(r.effects).toEqual([{ kind: "clear_input_buffer" }]);
  });

  it("input_edit opens the external editor with the current draft", () => {
    const r = reduce(
      makeState({ inputMode: true }),
      { kind: "input_edit", value: "draft" },
      makeCtx(),
    );
    expect(r.effects).toEqual([{ kind: "open_input_editor", value: "draft" }]);
  });

  it("input_replace stores and rehydrates the edited value", () => {
    const r = reduce(
      makeState({ inputMode: true }),
      { kind: "input_replace", value: "edited" },
      makeCtx(),
    );
    expect(r.state.customDraftsByTab.get(0)).toBe("edited");
    expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "edited" }]);
  });
});

describe("reduce — edit_enter / edit_exit (inline 'Type something.' editor)", () => {
  const multiCtx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
  const singleCtx = makeCtx({ questions: [makeQuestion()] });

  it("edit_enter opens inputMode and seeds the buffer from the committed custom entry", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["A", "custom text"] }],
    ]);
    const r = reduce(makeState({ answers, optionIndex: 2 }), { kind: "edit_enter" }, multiCtx);
    expect(r.state.inputMode).toBe(true);
    expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "custom text" }]);
  });

  it("edit_exit with commit=true and a non-empty draft checks the other row and keeps focus there", () => {
    const state = makeState({ inputMode: true, optionIndex: 2 });
    const r = reduce(state, { kind: "edit_exit", commit: true, draft: "typed" }, multiCtx);
    expect(r.state.inputMode).toBe(false);
    expect(r.state.optionIndex).toBe(2);
    expect(r.state.multiSelectChecked.has(2)).toBe(true);
    expect(r.state.customDraftsByTab.get(0)).toBe("typed");
  });

  it("edit_exit with commit=true but a whitespace-only draft does NOT check the other row", () => {
    const state = makeState({ inputMode: true, customDraftsByTab: new Map([[0, ""]]) });
    const r = reduce(state, { kind: "edit_exit", commit: true, draft: "   " }, multiCtx);
    expect(r.state.inputMode).toBe(false);
    expect(r.state.multiSelectChecked.has(2)).toBe(false);
    // The whitespace draft is still snapshotted so a tab round-trip restores it verbatim.
    expect(r.state.customDraftsByTab.get(0)).toBe("   ");
  });

  it("edit_exit with commit=false unchecks the other row and keeps the draft", () => {
    const state = makeState({
      inputMode: true,
      optionIndex: 2,
      multiSelectChecked: new Set([0, 2]),
    });
    const r = reduce(state, { kind: "edit_exit", commit: false, draft: "draft kept" }, multiCtx);
    expect(r.state.inputMode).toBe(false);
    expect(r.state.optionIndex).toBe(2);
    expect(r.state.multiSelectChecked.has(2)).toBe(false);
    expect(r.state.multiSelectChecked.has(0)).toBe(true);
    expect(r.state.customDraftsByTab.get(0)).toBe("draft kept");
  });

  it("single-select edit_exit falls back to the first option row (no stranded half-open editor)", () => {
    const state = makeState({ inputMode: true, optionIndex: 2 });
    const r = reduce(state, { kind: "edit_exit", commit: false, draft: "wip" }, singleCtx);
    expect(r.state.inputMode).toBe(false);
    expect(r.state.optionIndex).toBe(0);
    expect(r.state.customDraftsByTab.get(0)).toBe("wip");
  });
});

describe("reduce — submit_nav / ignore", () => {
  it("submit_nav updates submitChoiceIndex with no effects", () => {
    const r = reduce(makeState(), { kind: "submit_nav", nextIndex: 1 }, makeCtx());
    expect(r.state.submitChoiceIndex).toBe(1);
    expect(r.effects).toEqual([]);
  });

  it("ignore is identity (state unchanged, no effects)", () => {
    const s = makeState({ optionIndex: 2 });
    const r = reduce(s, { kind: "ignore" }, makeCtx());
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });
});

describe("reduce — toggle_collapsed", () => {
  it("flips false → true and emits set_overlay_hidden(true) so the runtime hides the overlay", () => {
    const r = reduce(makeState(), { kind: "toggle_collapsed" }, makeCtx());
    expect(r.state.collapsed).toBe(true);
    expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: true }]);
  });

  it("flips true → false (expand round-trip) and emits set_overlay_hidden(false)", () => {
    const r = reduce(makeState({ collapsed: true }), { kind: "toggle_collapsed" }, makeCtx());
    expect(r.state.collapsed).toBe(false);
    expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: false }]);
  });

  it("preserves orthogonal fields — collapse is a pure render-mode flip, never touches answers/optionIndex/notes", () => {
    const answers = new Map<QuestionAnswer["questionIndex"], QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["A"] }],
    ]);
    const s = makeState({ optionIndex: 1, notesVisible: true, notesDraft: "in-flight", answers });
    const r = reduce(s, { kind: "toggle_collapsed" }, makeCtx());
    expect(r.state.collapsed).toBe(true);
    expect(r.state.optionIndex).toBe(1);
    expect(r.state.notesVisible).toBe(true);
    expect(r.state.notesDraft).toBe("in-flight");
    expect(r.state.answers).toBe(answers);
    expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: true }]);
  });
});

describe("reduce — multi-select notes merge", () => {
  it("confirm attaches a pending note onto the multi answer", () => {
    const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
    const state = makeState({ notesByTab: new Map([[0, "side note"]]) });
    const r = reduce(
      state,
      { kind: "confirm", answer: { questionIndex: 0, question: "Pick one", selected: ["A"] } },
      ctx,
    );
    const answer = r.state.answers.get(0);
    expect(answer?.selected).toEqual(["A"]);
    expect(answer?.notes).toBe("side note");
  });

  it("confirm with empty notesByTab persists an answer with NO notes field (negative case)", () => {
    const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
    const r = reduce(
      makeState(),
      { kind: "confirm", answer: { questionIndex: 0, question: "Pick one", selected: ["A"] } },
      ctx,
    );
    const answer = r.state.answers.get(0);
    expect(answer?.selected).toEqual(["A"]);
    expect(answer?.notes).toBeUndefined();
  });

  it("strip round-trip: notes_exit with an empty draft strips notes from the answer; a subsequent confirm does not resurrect it", () => {
    const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["A"], notes: "stale" }],
    ]);
    let state = makeState({
      answers,
      notesByTab: new Map([[0, "stale"]]),
      notesVisible: true,
      notesDraft: "   ",
      multiSelectChecked: new Set([0]),
    });
    state = reduce(state, { kind: "notes_exit" }, ctx).state;
    expect(state.answers.get(0)?.notes).toBeUndefined();
    expect(state.notesByTab.has(0)).toBe(false);
    const after = reduce(
      state,
      { kind: "confirm", answer: { questionIndex: 0, question: "Pick one", selected: ["A", "B"] } },
      ctx,
    ).state;
    expect(after.answers.get(0)?.selected).toEqual(["A", "B"]);
    expect(after.answers.get(0)?.notes).toBeUndefined();
  });
});

describe("reduce — global note at the Submit-tab pseudo-index", () => {
  const twoQuestionCtx = makeCtx({
    questions: [makeQuestion(), makeQuestion()],
    itemsByTab: [itemsRegular, itemsRegular],
  });

  function submitState(over: Partial<Parameters<typeof makeState>[0]> = {}) {
    return makeState({ currentTab: 2, ...over });
  }

  it("notes_enter seeds notesDraft from notesByTab[questions.length]", () => {
    const r = reduce(
      submitState({ notesByTab: new Map([[2, "ship it Friday"]]) }),
      { kind: "notes_enter" },
      twoQuestionCtx,
    );
    expect(r.state.notesVisible).toBe(true);
    expect(r.state.notesDraft).toBe("ship it Friday");
    expect(r.effects).toEqual([
      { kind: "set_notes_value", value: "ship it Friday" },
      { kind: "set_notes_focused", focused: true },
    ]);
  });

  it("notes_exit writes the trimmed draft into notesByTab[questions.length], leaving answers untouched", () => {
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["A"] }],
    ]);
    const r = reduce(
      submitState({ answers, notesVisible: true, notesDraft: "  global  " }),
      { kind: "notes_exit" },
      twoQuestionCtx,
    );
    expect(r.state.notesVisible).toBe(false);
    expect(r.state.notesByTab.get(2)).toBe("global");
    expect(r.state.answers.get(2)).toBeUndefined();
    expect([...r.state.answers.entries()]).toEqual([...answers.entries()]);
  });

  it("notes_exit with an empty draft deletes the pseudo-index key", () => {
    const r = reduce(
      submitState({ notesByTab: new Map([[2, "stale"]]), notesVisible: true, notesDraft: "   " }),
      { kind: "notes_exit" },
      twoQuestionCtx,
    );
    expect(r.state.notesByTab.has(2)).toBe(false);
  });

  it("tab away and back reseeds the shared editor via switchTabResult", () => {
    let s = submitState({ notesByTab: new Map([[2, "keep me"]]) });
    s = reduce(s, { kind: "tab_switch", nextTab: 0 }, twoQuestionCtx).state;
    expect(s.currentTab).toBe(0);
    expect(s.notesVisible).toBe(false);
    expect(s.notesDraft).toBe("");
    s = reduce(s, { kind: "tab_switch", nextTab: 2 }, twoQuestionCtx).state;
    expect(s.currentTab).toBe(2);
    expect(s.notesDraft).toBe("keep me");
  });
});

describe("reduce — customDraftValueFor via multi-select restore", () => {
  it("a custom entry is re-derived from a committed answer when no draft exists", () => {
    const ctx = makeCtx({
      questions: [makeQuestion({ multiSelect: true })],
      itemsByTab: [itemsWithOther],
    });
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["A", "custom text"] }],
    ]);
    const r = reduce(makeState({ answers, optionIndex: 2 }), { kind: "edit_enter" }, ctx);
    expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "custom text" }]);
  });

  it("an in-flight draft takes precedence over the committed custom entry", () => {
    const ctx = makeCtx({
      questions: [makeQuestion({ multiSelect: true })],
      itemsByTab: [itemsWithOther],
    });
    const answers = new Map<number, QuestionAnswer>([
      [0, { questionIndex: 0, question: "Pick one", selected: ["custom text"] }],
    ]);
    const state = makeState({
      answers,
      optionIndex: 2,
      customDraftsByTab: new Map([[0, "newer draft"]]),
    });
    const r = reduce(state, { kind: "edit_enter" }, ctx);
    expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "newer draft" }]);
  });
});
