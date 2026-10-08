import { describe, expect, it } from "vitest";
import { formatCardWorkUpdateMessage, projectCardWorkUpdate } from "../src/cards/card_work_update_projection.js";
import type { CardItem } from "../src/cards/card_item_rules.js";
import type { CardRow, FolderOperationRow } from "../src/cards/control_plane/card_types.js";

const makeItem = (overrides: Partial<CardItem> = {}): CardItem => ({
  id: 1,
  title: "검색 결과 확인",
  state: "done",
  result: "결과 저장",
  evidence: [{ type: "link", url: "https://example.test/result", label: "검증 화면" }],
  caveat: "실기기 확인은 남음",
  rev: 3,
  confirmed: null,
  fixOpen: 0,
  reopened: null,
  from: null,
  createdAt: "2026-10-08T06:00:00.000Z",
  reportedAt: "2026-10-08T06:10:00.000Z",
  ...overrides,
});

const makeCard = (overrides: Partial<CardRow> = {}): CardRow => ({
  id: "card-1",
  number: 238,
  title: "PAS 컨텍스트와 응답 시간 절약",
  version: 12,
  status: "running",
  items: [],
  now: null,
  blocked_kind: null,
  blocked_detail: null,
  request: "상세 요청 본문은 envelope에서 제외",
  brief: "인계 본문은 envelope에서 제외",
  ...overrides,
} as unknown as CardRow);

const makeOperation = (operation_type: string, payload_json: Record<string, unknown> = {}, overrides: Partial<FolderOperationRow> = {}): FolderOperationRow => ({
  id: "operation-1",
  target_kind: "card",
  target_id: "card-1",
  operation_type,
  created_at: new Date("2026-10-08T06:20:00.000Z"),
  payload_json,
  ...overrides,
} as unknown as FolderOperationRow);

describe("card work update projection", () => {
  it.each(["done", "dropped"] as const)("projects the exact stored %s item result and bounded envelope", (state) => {
    const item = makeItem({ state });
    const operation = makeOperation("report_card_item", {
      item_id: item.id,
      state,
      summary: "저장된 요약",
      verification: { checked: ["계약 테스트"], unchecked: ["실기기 확인"] },
      body: "큰 원문은 포함하지 않음",
    });
    const card = makeCard({ items: [item, makeItem({ id: 2, title: "다음 작업", state: "todo", result: null, evidence: [], caveat: null, rev: 0, reportedAt: null })] });

    const update = projectCardWorkUpdate(operation, card);

    expect(update).toMatchObject({
      schema: "card_work_update.v1",
      kind: "item_result",
      event_id: "operation-1",
      saved_at: "2026-10-08T06:20:00.000Z",
      card: { id: "card-1", number: 238, title: "PAS 컨텍스트와 응답 시간 절약", version: 12, status: "running" },
      item: {
        id: item.id,
        title: item.title,
        rev: 3,
        state,
        result: item.result,
        evidence: item.evidence,
        caveat: item.caveat,
        confirmed: null,
        fixOpen: 0,
        display: state === "dropped" ? "dropped" : "reported",
      },
      verification: { checked: ["계약 테스트"], unchecked: ["실기기 확인"] },
      summary: "저장된 요약",
      detail_ref: { card_id: "card-1", operation_id: "operation-1" },
    });
    expect(update?.remaining).toEqual([
      { id: 1, title: "검색 결과 확인", state, rev: 3, confirmed: null, fixOpen: 0, needsConfirmation: state === "done" },
      { id: 2, title: "다음 작업", state: "todo", rev: 0, confirmed: null, fixOpen: 0, needsConfirmation: false },
    ].filter((entry) => state !== "dropped" || entry.id === 2));
    expect(JSON.stringify(update)).not.toContain("큰 원문은 포함하지 않음");
    expect(JSON.stringify(update)).not.toContain("상세 요청 본문");
    expect(projectCardWorkUpdate(operation, card)).toEqual(update);
  });

  it("uses exact report, question, and reply rows and rejects mismatched IDs", () => {
    const reportOperation = makeOperation("add_card_report", { report_id: "report-1", summary: null, body: "HTML 원문" });
    expect(projectCardWorkUpdate(reportOperation, makeCard(), { report: { id: "report-1", title: "저장된 보고" } }))
      .toMatchObject({ kind: "report", verification: null, summary: null, report: { id: "report-1", title: "저장된 보고", summary: null, detailRequired: true } });
    expect(projectCardWorkUpdate(makeOperation("add_card_report", { report_id: "report-1", summary: "저장된 짧은 요약" }), makeCard(), {
      report: { id: "report-1", title: "저장된 보고" },
    })).toMatchObject({ summary: "저장된 짧은 요약", report: { summary: "저장된 짧은 요약", detailRequired: false } });
    expect(() => projectCardWorkUpdate(reportOperation, makeCard(), { report: { id: "report-2", title: "다른 보고" } })).toThrow();
    expect(() => projectCardWorkUpdate(reportOperation, makeCard())).toThrow(/saved row ID/);
    expect(() => projectCardWorkUpdate(makeOperation("add_card_report", { summary: "요약" }), makeCard(), {
      report: { id: "report-1", title: "저장된 보고" },
    })).toThrow(/saved row ID/);

    const questionOperation = makeOperation("ask_card_question", { question_id: "question-1" });
    expect(projectCardWorkUpdate(questionOperation, makeCard(), {
      question: { id: "question-1", text: "계속할까요?", options: ["진행", "대기"] },
    })).toMatchObject({ kind: "question", question: { id: "question-1", text: "계속할까요?", options: ["진행", "대기"] } });
    expect(() => projectCardWorkUpdate(questionOperation, makeCard(), {
      question: { id: "question-2", text: "다른 질문", options: null },
    })).toThrow();
    expect(() => projectCardWorkUpdate(questionOperation, makeCard())).toThrow(/saved row ID/);

    const replyOperation = makeOperation("add_card_comment", { author_kind: "agent", comment_id: "reply-1" });
    expect(projectCardWorkUpdate(replyOperation, makeCard(), { reply: { id: "reply-1", body: "저장된 답변" } }))
      .toMatchObject({ kind: "reply", reply: { id: "reply-1", body: "저장된 답변" } });
    expect(() => projectCardWorkUpdate(replyOperation, makeCard(), { reply: { id: "reply-2", body: "다른 답변" } })).toThrow();
    expect(() => projectCardWorkUpdate(replyOperation, makeCard())).toThrow(/saved row ID/);
    expect(projectCardWorkUpdate(makeOperation("add_card_comment", { author_kind: "user", comment_id: "user-comment" }), makeCard(), {
      reply: { id: "user-comment", body: "사용자 글" },
    })).toBeNull();
  });

  it.each([
    ["blocked", { status: "blocked" }, { kind: "question", detail: "답변 대기" }, undefined],
    ["review", { status: "review" }, undefined, [3, 4, 5, 6, 7, 8]],
    ["done", { status: "done" }, undefined, [3, 4, 5, 6, 7, 8]],
    ["cancelled", { status: "cancelled" }, undefined, [3, 4, 5, 6, 7, 8]],
  ] as const)("projects explicit %s status with only its compact state", (kind, payload, blocked, expectedItems) => {
    const items = Array.from({ length: 8 }, (_, index) => makeItem({ id: index + 1, title: `항목 ${index + 1}` }));
    const update = projectCardWorkUpdate(makeOperation("set_card_status", payload), makeCard({
      status: payload.status as CardRow["status"],
      blocked_kind: "question",
      blocked_detail: "답변 대기",
      items,
    }));

    expect(update?.kind).toBe(kind);
    if (kind === "blocked") expect(update).toMatchObject({ blocked });
    if (expectedItems && update && (update.kind === "review" || update.kind === "done" || update.kind === "cancelled"))
      expect(update.items.map((item) => item.id)).toEqual(expectedItems);
  });

  it("keeps now updates quiet and leaves progress or unrelated operations quiet", () => {
    for (const turn of ["user", "outside", "agent", null] as const) {
      const now = turn === null ? null : {
        text: turn === "user" ? "사용자 결정 필요" : turn === "outside" ? "외부 응답 대기" : "진행 중",
        turn,
        ask: turn === "user" ? "계속할까요?" : null,
        updatedAt: "2026-10-08T06:00:00.000Z",
        sessionId: turn === "agent" ? "agent-1" : null,
      };
      expect(projectCardWorkUpdate(makeOperation("update_card_now", {}), makeCard({ now }))).toBeNull();
    }
    expect(projectCardWorkUpdate(makeOperation("report_card_item", { item_id: 1, state: "doing" }), makeCard({ items: [makeItem({ state: "doing" })] }))).toBeNull();
    expect(() => projectCardWorkUpdate(makeOperation("report_card_item", { item_id: 99, state: "done" }), makeCard({ items: [makeItem()] })))
      .toThrow(/saved item ID/);
    for (const operationType of ["add_card_note", "update_card", "set_card_items", "confirm_card_item", "start_card_work", "execute_card", "dispatch_card", "answer_card_question", "move_card", "reorder_card_queue", "add_card_item", "create_card"]) {
      expect(projectCardWorkUpdate(makeOperation(operationType), makeCard())).toBeNull();
    }
    expect(projectCardWorkUpdate(makeOperation("set_card_status", { status: "running" }), makeCard())).toBeNull();
    expect(projectCardWorkUpdate(makeOperation("report_card_item", { item_id: 1, state: "done" }, { target_kind: "folder" }), makeCard())).toBeNull();
    expect(projectCardWorkUpdate(makeOperation("report_card_item", { item_id: 1, state: "done" }, { target_id: "card-2" }), makeCard())).toBeNull();
  });

  it("keeps remaining in stored order, preserves confirmation objects, excludes dropped, and caps at six", () => {
    const items = [
      makeItem({ id: 1, state: "done", confirmed: { at: "2026-10-08T06:00:00.000Z", rev: 3 } }),
      makeItem({ id: 2, state: "dropped", fixOpen: 2 }),
      makeItem({ id: 3, state: "done", confirmed: null }),
      makeItem({ id: 4, state: "done", confirmed: { at: "2026-10-08T06:01:00.000Z", rev: 3 }, fixOpen: 1 }),
      ...Array.from({ length: 7 }, (_, index) => makeItem({ id: index + 5, state: "todo", confirmed: null, fixOpen: 0 })),
    ];
    const update = projectCardWorkUpdate(makeOperation("ask_card_question", { question_id: "q" }), makeCard({ items }), {
      question: { id: "q", text: "확인?", options: null },
    });

    expect(update?.remaining.map((item) => item.id)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(update?.remaining[0]).toMatchObject({ state: "done", confirmed: null, needsConfirmation: true });
    expect(update?.remaining[1]).toMatchObject({ state: "done", confirmed: { at: "2026-10-08T06:01:00.000Z", rev: 3 }, needsConfirmation: false });
  });

  it("formats only the compact serialized update with UTF-8 text", () => {
    const update = projectCardWorkUpdate(makeOperation("add_card_report", { report_id: "report-1", body: "제외할 HTML 원문" }), makeCard(), {
      report: { id: "report-1", title: "결과 보고" },
    });
    expect(update).not.toBeNull();
    const message = formatCardWorkUpdateMessage(update!);
    expect(message).toBe(`[카드 결과 알림]\n${JSON.stringify(update)}`);
    expect(message).toContain("결과 보고");
    expect(message).not.toContain("제외할 HTML 원문");
    expect(message).not.toContain("\\u");
  });
});
