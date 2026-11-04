import { describe, expect, it } from "vitest";
import {
  buildAnswerSegment,
  buildQuestionnaireResponse,
  DECLINE_MESSAGE,
  ENVELOPE_PREFIX,
  ENVELOPE_SUFFIX,
} from "../../src/tool/response-envelope.js";
import type { QuestionParams, QuestionnaireResult } from "../../src/tool/types.js";
import { makeQuestion } from "../helpers/test-fixtures.js";

const params: QuestionParams = {
  questions: [
    makeQuestion({ question: "Which auth?", header: "Auth" }),
    makeQuestion({ question: "Which lib?", header: "Lib" }),
  ],
};

const answered: QuestionnaireResult = {
  cancelled: false,
  answers: [
    { questionIndex: 0, question: "Which auth?", selected: ["JWT"] },
    { questionIndex: 1, question: "Which lib?", selected: ["date-fns"] },
  ],
};

describe("buildQuestionnaireResponse — answered envelope", () => {
  it("emits one header-keyed line per answered question between prefix and suffix", () => {
    const r = buildQuestionnaireResponse(answered, params);
    expect(r.content[0]!.text).toBe(
      `${ENVELOPE_PREFIX}\nAuth="JWT"\nLib="date-fns"\n${ENVELOPE_SUFFIX}`,
    );
    expect(r.details).toBe(answered);
  });

  it("keys lines by header, never echoing the full question text", () => {
    const text = buildQuestionnaireResponse(answered, params).content[0]!.text;
    expect(text).not.toContain("Which auth?");
    expect(text).not.toContain("Which lib?");
  });

  it("skips unanswered questions (partial submission)", () => {
    const partial: QuestionnaireResult = { cancelled: false, answers: [answered.answers[1]!] };
    const text = buildQuestionnaireResponse(partial, params).content[0]!.text;
    expect(text).not.toContain("Auth=");
    expect(text).toContain('Lib="date-fns"');
  });

  it("joins multi-select selections with commas on one line", () => {
    const multi: QuestionnaireResult = {
      cancelled: false,
      answers: [{ questionIndex: 0, question: "Which auth?", selected: ["JWT", "OAuth"] }],
    };
    expect(buildQuestionnaireResponse(multi, params).content[0]!.text).toContain(
      'Auth="JWT, OAuth"',
    );
  });

  it("appends a per-question note as a `user notes:` suffix on the same line", () => {
    const noted: QuestionnaireResult = {
      cancelled: false,
      answers: [
        {
          questionIndex: 0,
          question: "Which auth?",
          selected: ["JWT"],
          notes: "refresh tokens too",
        },
      ],
    };
    const text = buildQuestionnaireResponse(noted, params).content[0]!.text;
    expect(text).toContain('Auth="JWT". user notes: refresh tokens too');
  });

  it("emits the global note as its own line after the answer lines", () => {
    const text = buildQuestionnaireResponse(
      { ...answered, globalNote: "prefer small deps" },
      params,
    ).content[0]!.text;
    expect(text).toBe(
      `${ENVELOPE_PREFIX}\nAuth="JWT"\nLib="date-fns"\nglobal note: prefer small deps\n${ENVELOPE_SUFFIX}`,
    );
  });

  it("a global note alone still yields the answered envelope", () => {
    const r = buildQuestionnaireResponse(
      { cancelled: false, answers: [], globalNote: "only this" },
      params,
    );
    expect(r.content[0]!.text).toBe(
      `${ENVELOPE_PREFIX}\nglobal note: only this\n${ENVELOPE_SUFFIX}`,
    );
    expect(r.details.cancelled).toBe(false);
  });

  it("falls back to Q<index+1> when the header is an empty string", () => {
    const headerless: QuestionParams = { questions: [makeQuestion({ header: "" })] };
    const result: QuestionnaireResult = {
      cancelled: false,
      answers: [{ questionIndex: 0, question: "Pick one", selected: ["A"] }],
    };
    expect(buildQuestionnaireResponse(result, headerless).content[0]!.text).toContain('Q1="A"');
  });
});

describe("buildQuestionnaireResponse — decline envelope", () => {
  it("null result declines", () => {
    const r = buildQuestionnaireResponse(null, params);
    expect(r.content[0]!.text).toBe(DECLINE_MESSAGE);
    expect(r.details).toEqual({ answers: [], cancelled: true });
  });

  it("cancelled result declines but keeps answers and global note in details", () => {
    const cancelled: QuestionnaireResult = {
      ...answered,
      cancelled: true,
      globalNote: "still noted",
    };
    const r = buildQuestionnaireResponse(cancelled, params);
    expect(r.content[0]!.text).toBe(DECLINE_MESSAGE);
    expect(r.details.answers).toEqual(cancelled.answers);
    expect(r.details.globalNote).toBe("still noted");
  });

  it("zero answers and no global note declines even when not cancelled", () => {
    const r = buildQuestionnaireResponse({ cancelled: false, answers: [] }, params);
    expect(r.content[0]!.text).toBe(DECLINE_MESSAGE);
    expect(r.details.cancelled).toBe(true);
  });
});

describe("buildAnswerSegment", () => {
  it('formats header="answer" with an optional notes suffix', () => {
    const q = makeQuestion({ header: "Auth" });
    expect(buildAnswerSegment({ questionIndex: 0, question: "q", selected: ["JWT"] }, q, 0)).toBe(
      'Auth="JWT"',
    );
    expect(
      buildAnswerSegment({ questionIndex: 0, question: "q", selected: ["JWT"], notes: "n" }, q, 0),
    ).toBe('Auth="JWT". user notes: n');
  });

  it("renders an empty selection with the (no input) placeholder", () => {
    expect(
      buildAnswerSegment({ questionIndex: 0, question: "q", selected: [] }, undefined, 2),
    ).toBe('Q3="(no input)"');
  });
});
