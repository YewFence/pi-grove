import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_QUESTIONS } from "../../src/config.js";
import {
  createQuestionParamsSchema,
  createQuestionsSchema,
  isQuestionnaireResult,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MIN_OPTIONS,
  type QuestionAnswer,
  type QuestionData,
  type QuestionnaireResult,
  QuestionParamsSchema,
  QuestionsSchema,
  RESERVED_LABELS,
} from "../../src/tool/types.js";

function makeQuestion(override: Partial<QuestionData> = {}): QuestionData {
  return {
    question: override.question ?? "What's your name?",
    header: override.header ?? "Hdr",
    options: override.options ?? [
      { label: "A", description: "Choice A" },
      { label: "B", description: "Choice B" },
    ],
    multiSelect: override.multiSelect,
  };
}

describe("QuestionsSchema — array constraints", () => {
  it("accepts a single question", () => {
    expect(Value.Check(QuestionsSchema, [makeQuestion()])).toBe(true);
  });

  it("accepts the default maximum (4) questions", () => {
    const four = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
    expect(Value.Check(QuestionsSchema, four)).toBe(true);
  });

  it("rejects empty array (minItems=1)", () => {
    expect(Value.Check(QuestionsSchema, [])).toBe(false);
  });

  it("rejects more than the default maximum with the default schema", () => {
    const five = [makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()];
    expect(Value.Check(QuestionsSchema, five)).toBe(false);
    expect(DEFAULT_MAX_QUESTIONS).toBe(4);
  });

  it("supports a configured finite maximum", () => {
    const schema = createQuestionsSchema(2);
    expect(Value.Check(schema, [makeQuestion(), makeQuestion()])).toBe(true);
    expect(Value.Check(schema, [makeQuestion(), makeQuestion(), makeQuestion()])).toBe(false);
  });

  it("omits maxItems when configured as unlimited", () => {
    const schema = createQuestionsSchema(0);
    const many = Array.from({ length: 20 }, () => makeQuestion());
    expect(Value.Check(schema, many)).toBe(true);
    expect("maxItems" in schema).toBe(false);
    expect("maxItems" in createQuestionParamsSchema(0).properties.questions).toBe(false);
  });
});

describe("QuestionSchema — option/preview/multiSelect/header shape", () => {
  it("accepts options with optional preview field", () => {
    const q = makeQuestion({
      options: [
        { label: "A", description: "alpha", preview: "## A\n\nbody" },
        { label: "B", description: "beta" },
      ],
    });
    expect(Value.Check(QuestionsSchema, [q])).toBe(true);
  });

  it("accepts a question with all optional fields populated", () => {
    const q: QuestionData = {
      question: "Pick architecture",
      header: "Architecture",
      options: [
        {
          label: "Monolith",
          description: "Single deployable unit",
          preview: "## Monolith\n\nSimple",
        },
        {
          label: "Microservices",
          description: "Distributed services",
          preview: "## Micro\n\nScalable",
        },
      ],
      multiSelect: false,
    };
    expect(Value.Check(QuestionsSchema, [q])).toBe(true);
  });

  it("accepts multiSelect: true", () => {
    expect(Value.Check(QuestionsSchema, [makeQuestion({ multiSelect: true })])).toBe(true);
  });

  it("accepts a header up to MAX_HEADER_LENGTH chars", () => {
    expect(Value.Check(QuestionsSchema, [makeQuestion({ header: "Architecture" })])).toBe(true);
  });

  it("rejects a single-option question (minItems=2)", () => {
    expect(
      Value.Check(QuestionsSchema, [
        makeQuestion({ options: [{ label: "OK", description: "Only choice" }] }),
      ]),
    ).toBe(false);
  });

  it("rejects empty options array (minItems=2)", () => {
    expect(Value.Check(QuestionsSchema, [makeQuestion({ options: [] })])).toBe(false);
  });

  it("rejects more than MAX_OPTIONS options (maxItems=4)", () => {
    const five = [
      { label: "A", description: "alpha" },
      { label: "B", description: "beta" },
      { label: "C", description: "gamma" },
      { label: "D", description: "delta" },
      { label: "E", description: "epsilon" },
    ];
    expect(Value.Check(QuestionsSchema, [makeQuestion({ options: five })])).toBe(false);
    expect(MAX_OPTIONS).toBe(4);
  });

  it("rejects an option missing the required description", () => {
    const broken = makeQuestion({
      options: [{ label: "A" } as never, { label: "B", description: "ok" }],
    });
    expect(Value.Check(QuestionsSchema, [broken])).toBe(false);
  });

  it("rejects a question missing the required header", () => {
    const noHeader = {
      question: "Q?",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    };
    expect(Value.Check(QuestionsSchema, [noHeader])).toBe(false);
  });

  it("rejects a header longer than MAX_HEADER_LENGTH chars", () => {
    const tooLong = "x".repeat(MAX_HEADER_LENGTH + 1);
    expect(Value.Check(QuestionsSchema, [makeQuestion({ header: tooLong })])).toBe(false);
  });

  it("rejects a label longer than MAX_LABEL_LENGTH (60) chars", () => {
    const tooLong = "x".repeat(MAX_LABEL_LENGTH + 1);
    expect(
      Value.Check(QuestionsSchema, [
        makeQuestion({
          options: [
            { label: tooLong, description: "a" },
            { label: "B", description: "b" },
          ],
        }),
      ]),
    ).toBe(false);
  });

  it("rejects question with missing 'question' text", () => {
    const broken = {
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    } as unknown;
    expect(Value.Check(QuestionsSchema, [broken])).toBe(false);
  });
});

describe("QuestionParamsSchema — top-level shape", () => {
  it("accepts { questions: [...] }", () => {
    expect(Value.Check(QuestionParamsSchema, { questions: [makeQuestion()] })).toBe(true);
  });

  it("accepts full valid payload with preview + multiSelect", () => {
    const payload = {
      questions: [
        {
          question: "Choose",
          header: "Pick",
          multiSelect: true,
          options: [
            { label: "A", description: "First", preview: "# A" },
            { label: "B", description: "Second" },
          ],
        },
      ],
    };
    expect(Value.Check(QuestionParamsSchema, payload)).toBe(true);
  });

  it("rejects missing 'questions' field", () => {
    expect(Value.Check(QuestionParamsSchema, {})).toBe(false);
  });

  it("rejects non-array questions field", () => {
    expect(Value.Check(QuestionParamsSchema, { questions: "not array" })).toBe(false);
  });
});

describe("QuestionAnswer — selected + notes fields", () => {
  it("accepts an answer with notes populated", () => {
    const a: QuestionAnswer = {
      questionIndex: 0,
      question: "Q?",
      selected: ["A"],
      notes: "preview looked good",
    };
    expect(a.notes).toBe("preview looked good");
  });

  it("accepts an answer with multiple selected entries (multi-select)", () => {
    const a: QuestionAnswer = {
      questionIndex: 1,
      question: "Areas?",
      selected: ["Frontend", "Backend"],
    };
    expect(a.selected).toEqual(["Frontend", "Backend"]);
  });

  it("accepts an answer with a single custom-text entry", () => {
    const a: QuestionAnswer = {
      questionIndex: 0,
      question: "Q?",
      selected: ["free text"],
    };
    expect(a.selected).toEqual(["free text"]);
  });

  it("accepts an answer mixing option labels and custom text", () => {
    const a: QuestionAnswer = {
      questionIndex: 0,
      question: "Q?",
      selected: ["A", "B", "custom text"],
    };
    expect(a.selected).toHaveLength(3);
  });
});

describe("isQuestionnaireResult — type guard", () => {
  it("accepts a valid result", () => {
    const r: QuestionnaireResult = { answers: [], cancelled: false };
    expect(isQuestionnaireResult(r)).toBe(true);
  });

  it("accepts a result with error field", () => {
    expect(isQuestionnaireResult({ answers: [], cancelled: true, error: "no_ui" })).toBe(true);
  });

  it("accepts a result with the new error variants", () => {
    expect(
      isQuestionnaireResult({ answers: [], cancelled: true, error: "duplicate_question" }),
    ).toBe(true);
    expect(
      isQuestionnaireResult({ answers: [], cancelled: true, error: "duplicate_option_label" }),
    ).toBe(true);
    expect(isQuestionnaireResult({ answers: [], cancelled: true, error: "reserved_label" })).toBe(
      true,
    );
  });

  it("accepts a result carrying a globalNote (Submit-tab global note)", () => {
    expect(
      isQuestionnaireResult({ answers: [], cancelled: false, globalNote: "ship it Friday" }),
    ).toBe(true);
    expect(
      isQuestionnaireResult({ answers: [], cancelled: true, globalNote: "kept on cancel" }),
    ).toBe(true);
  });

  it("accepts a result with populated answers", () => {
    expect(
      isQuestionnaireResult({
        answers: [{ questionIndex: 0, question: "Q?", selected: ["A"] }],
        cancelled: false,
      }),
    ).toBe(true);
  });

  it("rejects null / undefined", () => {
    expect(isQuestionnaireResult(null)).toBe(false);
    expect(isQuestionnaireResult(undefined)).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isQuestionnaireResult(42)).toBe(false);
    expect(isQuestionnaireResult("oops")).toBe(false);
  });

  it("rejects an array", () => {
    expect(isQuestionnaireResult([])).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(isQuestionnaireResult({ answers: [] })).toBe(false);
    expect(isQuestionnaireResult({ cancelled: true })).toBe(false);
  });
});

describe("schema constants + RESERVED_LABELS", () => {
  it("exports the new schema constants with expected values", () => {
    expect(MIN_OPTIONS).toBe(2);
    expect(MAX_OPTIONS).toBe(4);
    expect(MAX_HEADER_LENGTH).toBe(16);
    expect(MAX_LABEL_LENGTH).toBe(60);
  });

  it("RESERVED_LABELS includes the Pi sentinels + CC's 'Other'", () => {
    expect(RESERVED_LABELS).toEqual(["Other", "Type something."]);
  });
});
