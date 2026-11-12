import { describe, expect, it } from "vitest";
import { cardOperationSchemas } from "../src/cards/card_operations.js";
import { buildCardQuestionThreadNotice } from "../src/cards/card_change_notification.js";
import { decideCardTransition } from "../src/cards/state/card_decision.js";
import type { CardDecisionEvidence } from "../src/cards/state/card_decision_facts.js";
import { statusLeaf } from "../src/cards/state/card_state_value.js";
import { cardBoardEntries } from "../src/session/card_board_entries.js";

const comment = (body: Record<string, unknown>) =>
  cardOperationSchemas.add_card_comment.strict().safeParse({ idempotencyKey: "idem-1", body: "글", ...body });
const rejectedPaths = (body: Record<string, unknown>): string[] => {
  const parsed = comment(body);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.path.join("."));
};

describe("add_card_comment input accepts a question thread reference", () => {
  it("accepts questionId on a user comment and on an assignee reply", () => {
    expect(comment({ questionId: "q-1" })).toMatchObject({ success: true, data: { questionId: "q-1" } });
    expect(comment({ questionId: "q-1", mode: "reply", body: "답" }))
      .toMatchObject({ success: true, data: { questionId: "q-1", mode: "reply" } });
  });
  it("keeps the old comment shape without a question", () => {
    expect(comment({ mode: "reply" }).success).toBe(true);
    expect(comment({ itemId: 2 }).success).toBe(true);
  });
  it.each([
    ["a question thread with an item", { questionId: "q-1", itemId: 2 }, "itemId"],
    ["a question thread with a spoken kind", { questionId: "q-1", kind: "spoken" }, "kind"],
    ["a question thread with a spoken mode", { questionId: "q-1", mode: "spoken" }, "mode"],
    ["an unknown field", { questionId: "q-1", question_thread: [] }, ""],
  ])("rejects %s", (_name, body, path) => expect(rejectedPaths(body)).toContain(path));
});

describe("question thread delivery text follows the question state", () => {
  const card = { id: "card-1", title: "질문 카드", status: "blocked" };
  const question = {
    id: "q-1", card_id: "card-1", text: "배경 설명", title: "정할 것" as string | null,
    answer: null as string | null, selected_option: null as string | null,
  };
  const requestLines = (id: string, closing: string) => [
    "[카드 질문 되묻기] 카드 「질문 카드」(card-1)",
    "질문: 정할 것",
    `질문 ID: ${id}`,
    "되물은 글: 선택지가 애매합니다",
    `질문은 아직 열려 있습니다. 카드 상태는 ${closing}입니다.`,
    `add_card_comment에 mode="reply", question_id="${id}"를 붙여 답하세요.`,
    `필요하면 ask_card_question에 question_id="${id}"를 붙여 질문을 제자리에서 고치세요.`,
  ].join("\n");
  const additionLines = (body: string[], closing: string) => [
    "[카드 질문 덧붙임] 카드 「질문 카드」(card-1)",
    "질문: 정할 것",
    "질문 ID: q-1",
    ...body,
    "덧붙인 글: 그렇게 갑니다",
    `질문은 닫혀 있습니다. 카드 상태는 ${closing}입니다.`,
    '답이 필요하면 add_card_comment에 mode="reply", question_id="q-1"를 붙여 답하세요.',
  ].join("\n");

  it("opens with the design 되묻기 text for an open question", () => {
    expect(buildCardQuestionThreadNotice(card, { ...question }, "선택지가 애매합니다"))
      .toBe(requestLines("q-1", "막힘"));
  });
  it("uses the question text when there is no title", () => {
    expect(buildCardQuestionThreadNotice(card, { ...question, title: null }, "선택지가 애매합니다"))
      .toBe(requestLines("q-1", "막힘").replace("질문: 정할 것", "질문: 배경 설명"));
  });
  it("appends to a choice answer with the chosen option label", () => {
    expect(buildCardQuestionThreadNotice({ ...card, status: "running" },
      { ...question, answer: "진행", selected_option: "진행" }, "그렇게 갑니다"))
      .toBe(additionLines(["받은 답: 고른 안: 진행"], "실행 중"));
  });
  it("keeps an answer addition from the choice answer on its own line", () => {
    expect(buildCardQuestionThreadNotice({ ...card, status: "running" },
      { ...question, answer: "문서도 고칩니다", selected_option: "진행" }, "그렇게 갑니다"))
      .toBe(additionLines(["받은 답: 고른 안: 진행", "덧붙임: 문서도 고칩니다"], "실행 중"));
  });
  it("appends to a text answer with the written answer", () => {
    expect(buildCardQuestionThreadNotice({ ...card, status: "running" },
      { ...question, answer: "직접 판단합니다", selected_option: null }, "그렇게 갑니다"))
      .toBe(additionLines(["받은 답: 글 답: 직접 판단합니다"], "실행 중"));
  });
});

const openQuestion = {
  id: "q-1", card_id: "card-1", session_id: "asker", text: "정할 것", options: ["진행"],
  answer: null, selected_option: null, withdrawn_at: null, asked_at: new Date("2026-11-12T00:00:00.000Z"),
};
const answeredQuestion = { ...openQuestion, answer: "진행", selected_option: "진행" };
const withdrawnQuestion = { ...openQuestion, withdrawn_at: new Date("2026-11-12T00:30:00.000Z") };
const otherOpenQuestion = { ...openQuestion, id: "q-2" };
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "card-1", status: "blocked", blocked_kind: "question", blocked_detail: "정할 것",
  assignee_kind: "session", assignee_session_id: "assignee", archived: false, items: [], ...overrides,
});
const user = { kind: "user", userId: "director" };
const command = (overrides: Record<string, unknown> = {}) => ({
  type: "ADD_COMMENT", body: "되묻는 글", entrance: "direct", ...overrides,
});
function decide(rowValue: Record<string, unknown>, questions: readonly Record<string, unknown>[],
  commandValue: Record<string, unknown>, actor: Record<string, unknown>, evidence: CardDecisionEvidence = {}) {
  return decideCardTransition(rowValue, questions, evidence, commandValue as never, actor,
    Date.parse("2026-11-12T02:00:00.000Z"));
}
const writes = (actions: readonly { type: string; params?: { kind?: string } }[]) =>
  actions.filter(action => action.type === "write").map(action => action.params?.kind ?? "card");

describe("question thread commands never close questions or move the card", () => {
  it("keeps a card blocked on its open question after a user 되묻기", () => {
    const decision = decide(row(), [openQuestion], command({ questionId: "q-1" }), user);
    expect(decision.kind).toBe("noop");
    expect(statusLeaf(decision.next)).toBe("question");
    expect(decision.next.question).toBe("open");
    expect(writes(decision.actions)).toEqual([]);
  });
  it("accepts a 덧붙이기 on an answered question without changing the card", () => {
    const decision = decide(row({ status: "running", blocked_kind: null, blocked_detail: null }),
      [answeredQuestion], command({ questionId: "q-1" }), user);
    expect(decision.kind).toBe("noop");
    expect(statusLeaf(decision.next)).toBe("running");
    expect(writes(decision.actions)).toEqual([]);
  });
  it.each([
    ["a withdrawn question", [withdrawnQuestion, otherOpenQuestion], "questionWithdrawn"],
    ["a question that is not on this card", [otherOpenQuestion], "questionMissing"],
  ])("rejects %s", (_name, questions, failure) => {
    const decision = decide(row(), questions, command({ questionId: "q-1" }), user);
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.failure.id).toBe(failure);
  });
  it.each([
    ["an item", { itemId: 2 }, "questionItem"],
    ["a spoken kind", { kind: "spoken" }, "questionSpoken"],
  ])("rejects a question thread with %s", (_name, overrides, failure) => {
    const decision = decide(row(), [openQuestion], command({ questionId: "q-1", ...overrides }), user);
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.failure.id).toBe(failure);
  });
});

describe("question thread replies follow the current assignee", () => {
  it("lets the question creating session answer when the card has no assignee", () => {
    const decision = decide(row({ assignee_kind: null, assignee_session_id: null }), [openQuestion],
      command({ questionId: "q-1", mode: "reply", body: "답" }), { kind: "agent", sessionId: "asker" },
      { userInput: true });
    expect(decision.kind).toBe("noop");
    expect(decision.next.assignee).toBe("none");
    expect(writes(decision.actions)).toEqual([]);
  });
  it("rejects the question creating session when another session is the assignee", () => {
    const decision = decide(row(), [openQuestion],
      command({ questionId: "q-1", mode: "reply", body: "답" }), { kind: "agent", sessionId: "asker" });
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.failure.id).toBe("replyOwner");
  });
  it("does not claim an agent assignee from a question thread reply", () => {
    const decision = decide(row({ assignee_kind: "agent", assignee_session_id: null }), [openQuestion],
      command({ questionId: "q-1", mode: "reply", body: "답" }), { kind: "agent", sessionId: "worker" },
      { claim: true, userInput: true });
    expect(decision.kind).toBe("noop");
    expect(decision.next.assignee).toBe("agent");
    expect(writes(decision.actions)).toEqual([]);
  });
});

describe("board entries carry the question thread without reading the database", () => {
  const card = {
    id: "card-1", number: 7, title: "질문 카드", status: "blocked", archived: false,
    blocked_kind: "question", blocked_detail: "정할 것",
    status_changed_at: "2026-11-12T00:00:00.000Z", updated_at: "2026-11-12T00:00:00.000Z", now: null,
  };
  const question = {
    id: "q-1", card_id: "card-1", text: "배경", options: ["진행"], answer: null, withdrawn_at: null,
    asked_at: "2026-11-12T00:00:00.000Z", title: "정할 것", kind: "choice" as const, attachments: [],
    option_details: null, selected_option: null, revision: 1, revised_at: null,
  };
  const entry = {
    id: "c-1", question_id: "q-1", author_kind: "user" as const, body: "되묻기",
    created_at: "2026-11-12T01:00:00.000Z", session_id: "s-1",
  };
  it("injects the thread and lets its last write move updated_at", () => {
    const entries = cardBoardEntries(card, [question], true, [], new Map([["q-1", [entry]]]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "cq_q-1", question_id: "q-1", question_thread: [entry],
      updated_at: "2026-11-12T01:00:00.000Z",
    });
  });
  it("keeps the old entry shape when the question has no thread", () => {
    expect(cardBoardEntries(card, [question], true)[0]!.question_thread).toBeUndefined();
  });
});
