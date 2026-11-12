import { describe, expect, it } from "vitest";
import {
  cardQuestionOptionLabels,
  normalizeCardQuestionOptions,
} from "../../packages/wire-schema/src/card_questions.js";
import {
  parsePersistentReportEntry,
  parsePersistentReportReply,
} from "../../packages/wire-schema/src/persistent_report.js";
import { cardBoardEntries, type BoardCard, type BoardQuestion } from "../src/session/card_board_entries.js";

const card: BoardCard = {
  id: "card-1", number: 7, title: "카드 제목", status: "blocked", archived: false,
  blocked_kind: "question", blocked_detail: null,
  status_changed_at: new Date("2026-01-01T00:00:00.000Z"), updated_at: new Date("2026-01-02T00:00:00.000Z"),
  now: null,
};
const question = (overrides: Partial<BoardQuestion> = {}): BoardQuestion => ({
  id: "q-1", card_id: "card-1", text: "배경 글", options: ["진행", "중단"], answer: null,
  withdrawn_at: null, asked_at: new Date("2026-01-03T00:00:00.000Z"), ...overrides,
});

describe("card question option normalization", () => {
  it("reads legacy string options as labels only and never infers description or recommendation", () => {
    expect(normalizeCardQuestionOptions(["진행", "중단"])).toEqual([{ label: "진행" }, { label: "중단" }]);
    expect(cardQuestionOptionLabels(["진행", "중단"])).toEqual(["진행", "중단"]);
  });

  it("keeps description and recommended from object options", () => {
    const options = [
      { label: "진행", description: "바로 실행합니다", recommended: true },
      { label: "중단", description: "멈춥니다" },
    ];
    expect(normalizeCardQuestionOptions(options)).toEqual(options);
    expect(cardQuestionOptionLabels(options)).toEqual(["진행", "중단"]);
  });

  it("keeps NULL options NULL for the compatible DTO and empty for details", () => {
    expect(cardQuestionOptionLabels(null)).toBeNull();
    expect(normalizeCardQuestionOptions(null)).toEqual([]);
    expect(cardQuestionOptionLabels(undefined)).toBeNull();
    expect(normalizeCardQuestionOptions(undefined)).toEqual([]);
    expect(cardQuestionOptionLabels([])).toEqual([]);
    expect(normalizeCardQuestionOptions([])).toEqual([]);
  });
});

describe("card question board entry projection", () => {
  it("keeps the legacy card-title fallback and fills the new question fields", () => {
    const [entry] = cardBoardEntries(card, [question()], true);
    expect(entry).toMatchObject({
      key: "cq_q-1", title: "카드 제목", context: "배경 글", options: ["진행", "중단"],
      question_text: "배경 글", question_kind: "choice", question_revision: 1,
      question_option_details: [{ label: "진행" }, { label: "중단" }],
      question_attachments: [], question_revised_at: null,
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    expect(entry!.question_title).toBeUndefined();
  });

  it("prefers the question title up to 40 characters", () => {
    const longTitle = "가".repeat(42);
    const [entry] = cardBoardEntries(card, [question({ title: longTitle })], true);
    expect(entry!.title).toBe("가".repeat(39) + "…");
    expect(entry!.question_title).toBe(longTitle);

    const [exact] = cardBoardEntries(card, [question({ title: "고를 것" })], true);
    expect(exact!.title).toBe("고를 것");
    expect(exact!.question_title).toBe("고를 것");
  });

  it("carries kind, details, attachments, selected option, revision and revised time", () => {
    const [entry] = cardBoardEntries(card, [question({
      title: "부탁",
      kind: "request",
      options: ["했어"],
      option_details: [{ label: "했어" }],
      attachments: [{ type: "link", label: "참고", url: "https://example.test/ref" }],
      selected_option: null,
      revision: 3,
      revised_at: new Date("2099-01-01T00:00:00.000Z"),
    })], true);
    expect(entry).toMatchObject({
      title: "부탁", question_kind: "request", question_revision: 3,
      question_option_details: [{ label: "했어" }],
      question_attachments: [{ type: "link", label: "참고", url: "https://example.test/ref" }],
      question_revised_at: "2099-01-01T00:00:00.000Z",
      updated_at: "2099-01-01T00:00:00.000Z",
    });
  });

  it("falls back to normalizing raw object options when the row was not projected", () => {
    const [entry] = cardBoardEntries(card, [question({
      options: [{ label: "진행", description: "바로" }] as unknown as string[],
      option_details: null,
      title: "  ",
    })], true);
    expect(entry!.title).toBe("카드 제목");
    expect(entry!.question_kind).toBe("choice");
    expect(entry!.question_option_details).toEqual([{ label: "진행", description: "바로" }]);
  });
});

describe("persistent report question fields", () => {
  const entry = { key: "deploy-270", kind: "ask", title: "배포 결정", card_numbers: [], context: "맥락", action: "결정", options: ["진행"] };

  it("rejects server-only question fields from PAS input", () => {
    for (const field of ["question_title", "question_text", "question_kind", "question_option_details", "question_attachments", "question_thread", "question_revision", "question_revised_at"]) {
      const parsed = parsePersistentReportEntry({ ...entry, [field]: "forged" });
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? [] : parsed.errors.map(error => error.path)).toContain(field);
    }
  });

  it("still parses the legacy board reply shape", () => {
    expect(parsePersistentReportReply([
      { key: "persistent_report_reply", content: { key: "cq_q-1", option: "진행" } },
    ])).toEqual({ key: "cq_q-1", option: "진행" });
  });
});
