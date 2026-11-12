import { describe, expect, it } from "vitest";
import { cardOperationSchemas } from "../src/cards/card_operations.js";

const ask = (body: Record<string, unknown>) =>
  cardOperationSchemas.ask_card_question.safeParse({ idempotencyKey: "idem-1", ...body });

function rejectedPaths(body: Record<string, unknown>): string[] {
  const parsed = ask(body);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.path.join("."));
}

const option = (label: string, overrides: Record<string, unknown> = {}) =>
  ({ label, description: `${label}을 고르면 이렇게 됩니다`, ...overrides });

describe("ask_card_question input boundaries", () => {
  const accepted: [string, Record<string, unknown>][] = [
    ["legacy text and string options exactly as before", { text: "어느 쪽으로 갈까요?", options: ["진행", "중단"] }],
    ["legacy long text without a title limit", { text: "가".repeat(1500), options: ["진행"] }],
    ["new shape with a 40 code point title", {
      title: "가".repeat(40), text: "배경", kind: "choice", options: [option("진행", { recommended: true }), option("중단")],
    }],
    ["new shape text at 1200 code points", { title: "정할 것", text: "가".repeat(1200), options: [option("진행")] }],
    ["four attachments shaped like item evidence", {
      title: "정할 것", text: "배경", options: [option("진행")],
      attachments: [
        { type: "image", label: "시안", attachment_id: "asset-1" },
        { type: "link", label: "참고", url: "https://example.test/ref" },
        { type: "image", label: "시안2", attachment_id: "asset-2" },
        { type: "link", label: "참고2", url: "https://example.test/ref2" },
      ],
    }],
    ["request with a title and no options", { title: "배포 확인", text: "직접 확인해 주세요", kind: "request" }],
    ["edit of an open question sends the whole body", {
      title: "정할 것", text: "고친 배경", kind: "choice", options: [option("진행")], questionId: "question-1",
    }],
  ];
  for (const [name, body] of accepted)
    it(`accepts ${name}`, () => expect(ask(body).success).toBe(true));

  const rejected: [string, Record<string, unknown>, string][] = [
    ["new shape without title", { kind: "choice", text: "배경", options: ["진행"] }, "title"],
    ["object options without title", { text: "배경", options: [option("진행")] }, "title"],
    ["edit without title", { text: "고친 배경", options: ["진행"], questionId: "question-1" }, "title"],
    ["title over 40 code points", { title: "가".repeat(41), text: "배경", options: ["진행"] }, "title"],
    ["title with a newline", { title: "정할\n것", text: "배경", options: ["진행"] }, "title"],
    ["blank title", { title: "   ", text: "배경", options: ["진행"] }, "title"],
    ["text over 1200 code points in the new shape", { title: "정할 것", text: "가".repeat(1201), options: [option("진행")] }, "text"],
    ["label over 12 code points", { title: "정할 것", text: "배경", options: [option("가".repeat(13))] }, "options"],
    ["description over 80 code points", {
      title: "정할 것", text: "배경", options: [option("진행", { description: "가".repeat(81) })],
    }, "options"],
    ["missing description", { title: "정할 것", text: "배경", options: [{ label: "진행" }] }, "options"],
    ["blank description", { title: "정할 것", text: "배경", options: [option("진행", { description: "   " })] }, "options"],
    ["description with a newline", {
      title: "정할 것", text: "배경", options: [option("진행", { description: "첫 줄\n둘째 줄" })],
    }, "options"],
    ["two recommended options", {
      title: "정할 것", text: "배경",
      options: [option("진행", { recommended: true }), option("중단", { recommended: true })],
    }, "options"],
    ["mixed string and object options", {
      title: "정할 것", text: "배경", options: ["진행", option("중단")],
    }, "options"],
    ["request with options", { title: "부탁", text: "배경", kind: "request", options: [] }, "options"],
    ["five attachments", {
      title: "정할 것", text: "배경", options: [option("진행")],
      attachments: Array.from({ length: 5 }, (_, index) => ({ type: "link", label: `참고${index}`, url: "https://example.test" })),
    }, "attachments"],
    ["legacy question without options", { text: "배경" }, "options"],
    ["new choice without options", { title: "정할 것", text: "배경", kind: "choice" }, "options"],
    ["unknown field", { title: "정할 것", text: "배경", options: [option("진행")], question_id: "question-1" }, ""],
  ];
  for (const [name, body, path] of rejected)
    it(`rejects ${name}`, () => expect(rejectedPaths(body)).toContain(path));

  it("uses the same evidence shape for item evidence and question attachments", () => {
    const evidence = { type: "image", label: "시안", attachment_id: "asset-1" };
    const item = cardOperationSchemas.report_card_item.safeParse({
      idempotencyKey: "idem-1", itemId: 1, state: "done", evidence: [evidence],
    });
    expect(item.success).toBe(true);
    expect(ask({
      title: "정할 것", text: "배경", options: [option("진행")], attachments: [evidence],
    }).success).toBe(true);
    for (const body of [
      { idempotencyKey: "idem-2", itemId: 1, state: "done", evidence: [{ ...evidence, read_context: { type: "card", id: "card-1" } }] },
      { idempotencyKey: "idem-3", title: "정할 것", text: "배경", options: [option("진행")],
        attachments: [{ ...evidence, read_context: { type: "card", id: "card-1" } }] },
    ]) {
      const operation = "itemId" in body ? cardOperationSchemas.report_card_item : cardOperationSchemas.ask_card_question;
      expect(operation.safeParse(body).success).toBe(false);
    }
  });
});
