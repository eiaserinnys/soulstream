import { describe, expect, it } from "vitest";
import {
  addCardItem,
  assertShortCardText,
  codePointLength,
  confirmCardItem,
  getCardItemDisplay,
  makeCardNow,
  openCardItemFix,
  questionCardNow,
  reportCardItem,
  reviewCardNow,
  setCardItems,
  type CardItem,
} from "../src/cards/card_item_rules.js";

const at = "2026-10-05T12:00:00.000Z";
const source = { commentId: "comment-1", kind: "comment" as const, at };

function item(overrides: Partial<CardItem> = {}): CardItem {
  return {
    id: 1,
    title: "결과를 확인합니다",
    state: "todo",
    result: null,
    evidence: [],
    caveat: null,
    rev: 0,
    confirmed: null,
    fixOpen: 0,
    reopened: null,
    from: null,
    createdAt: at,
    reportedAt: null,
    ...overrides,
  };
}

function expectInvalid(action: () => unknown, message: string) {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    statusCode: 422,
    code: "INVALID_CARD_REQUEST",
    message,
  });
}

describe("card item display", () => {
  it.each([
    [item({ state: "dropped", confirmed: { at, rev: 0 }, fixOpen: 2 }), "dropped"],
    [item({ confirmed: { at, rev: 0 }, fixOpen: 1, state: "doing" }), "confirmed"],
    [item({ fixOpen: 1, state: "doing" }), "fix"],
    [item({ state: "doing" }), "doing"],
    [item({ state: "done", reopened: "사용자 요청 반영" }), "changed"],
    [item({ state: "done" }), "reported"],
    [item(), "todo"],
  ] as const)("uses the first matching state in contract order", (cardItem, display) => {
    expect(getCardItemDisplay(cardItem)).toBe(display);
  });
});

describe("setCardItems", () => {
  it("creates one through six todo items with the complete initial state", () => {
    const result = setCardItems([], ["결과 하나", "결과 둘"], at);
    expect(result).toEqual([
      item({ id: 1, title: "결과 하나" }),
      item({ id: 2, title: "결과 둘" }),
    ]);
    expect(setCardItems([], Array.from({ length: 6 }, (_, i) => `결과 ${i + 1}`), at)).toHaveLength(6);
    expectInvalid(() => setCardItems([], [], at), "확인 항목은 하나에서 여섯까지입니다");
    expectInvalid(() => setCardItems([], Array.from({ length: 7 }, (_, i) => `결과 ${i + 1}`), at), "확인 항목은 하나에서 여섯까지입니다");
  });

  it("uses IDs above the current maximum when replacing an untouched list", () => {
    const current = [item({ id: 4 }), item({ id: 9 })];
    expect(setCardItems(current, ["새 결과"], at).map(({ id }) => id)).toEqual([10]);
  });

  it.each([
    [item({ result: "완료" }), "result"],
    [item({ confirmed: { at, rev: 0 } }), "confirmed"],
    [item({ fixOpen: 1 }), "fixOpen"],
    [item({ state: "done" }), "done"],
    [item({ state: "dropped" }), "dropped"],
  ] as const)("refuses to replace a list with existing %s", (changed, _field) => {
    expectInvalid(
      () => setCardItems([changed], ["새 결과"], at),
      "이미 결과나 확인이 달린 항목이 있습니다. 새 항목은 add_card_item으로 더하세요",
    );
  });
});

describe("addCardItem", () => {
  it("stores provenance and gives the new item the next card-local number", () => {
    const result = addCardItem([item({ id: 3 }), item({ id: 8, state: "done", result: "완료", rev: 1 })], "새 결과", source, at);
    expect(result.at(-1)).toMatchObject({ id: 9, title: "새 결과", from: source, state: "todo" });
  });

  it("requires a user comment source and limits only unconfirmed items", () => {
    expectInvalid(
      () => addCardItem([], "새 결과", null, at),
      "항목은 사용자의 글에서만 더할 수 있습니다. from_comment_id에 사용자 커멘트를 지정하세요",
    );
    const six = setCardItems([], Array.from({ length: 6 }, (_, i) => `결과 ${i + 1}`), at);
    expectInvalid(
      () => addCardItem(six, "일곱째", source, at),
      "확인하지 않은 항목이 여섯입니다. 사용자의 확인을 기다리세요",
    );
    const oneConfirmed = confirmCardItem(six, 1, true, at);
    expect(addCardItem(oneConfirmed, "일곱째", source, at).map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const overSixTotal = Array.from({ length: 7 }, (_, i) => item({
      id: i + 1,
      confirmed: i < 5 ? { at, rev: 0 } : null,
      state: i === 5 ? "dropped" : "todo",
    }));
    expect(addCardItem(overSixTotal, "추가", source, at).at(-1)?.id).toBe(8);
  });
});

describe("reportCardItem", () => {
  it("keeps evidence when omitted and replaces it when an array is supplied", () => {
    const current = [item({ evidence: [{ type: "link", url: "https://example.com", label: "기존 증거" }] })];
    expect(reportCardItem(current, 1, { state: "doing" }, at)[0]?.evidence).toEqual(current[0]?.evidence);
    expect(reportCardItem(current, 1, { state: "doing", evidence: [] }, at)[0]?.evidence).toEqual([]);
    expect(reportCardItem(current, 1, { state: "doing", evidence: Array.from({ length: 4 }, (_, i) => ({ type: "image" as const, url: `/evidence/${i}`, label: `증거 ${i}` })) }, at)[0]?.evidence).toHaveLength(4);
    expectInvalid(
      () => reportCardItem(current, 1, { state: "doing", evidence: Array.from({ length: 5 }, (_, i) => ({ type: "image" as const, url: `/evidence/${i}`, label: `증거 ${i}` })) }, at),
      "증거는 넷까지입니다",
    );
  });

  it("requires a result for done and dropped, increments revisions only for done", () => {
    expectInvalid(() => reportCardItem([item()], 1, { state: "done" }, at), "결과 한 줄(result)이 필요합니다");
    expectInvalid(() => reportCardItem([item()], 1, { state: "dropped", result: " " }, at), "결과 한 줄(result)이 필요합니다");
    expect(reportCardItem([item()], 1, { state: "done", result: "확인 완료" }, at)[0]).toMatchObject({
      state: "done", result: "확인 완료", rev: 1, reportedAt: at, fixOpen: 0,
    });
    expect(reportCardItem([item({ state: "done", result: "첫 결과", rev: 1 })], 1, { state: "done", result: "다시 확인" }, at)[0]?.rev).toBe(2);
    expect(reportCardItem([item()], 1, { state: "dropped", result: "요청에서 제외" }, at)[0]).toMatchObject({ state: "dropped", rev: 0, reportedAt: at });
  });

  it("requires a reason to change a confirmed item and reports a changed revision", () => {
    const confirmed = item({ state: "done", result: "이전 결과", rev: 2, confirmed: { at, rev: 2 } });
    expectInvalid(() => reportCardItem([confirmed], 1, { state: "doing" }, at), "사용자가 확인한 항목입니다. 고치려면 reopen_reason에 까닭을 적으세요");
    expectInvalid(() => reportCardItem([confirmed], 1, { state: "dropped", result: "취소", reopenReason: "요청 변경" }, at), "사용자가 확인한 항목은 뺄 수 없습니다");
    expect(reportCardItem([confirmed], 1, { state: "done", result: "고친 결과", reopenReason: "사용자 요청 반영" }, at)[0]).toMatchObject({
      state: "done", rev: 3, confirmed: null, reopened: "사용자 요청 반영",
    });
  });

  it("clears open fixes after a done result and retains a reopen marker", () => {
    expect(reportCardItem([item({ state: "doing", fixOpen: 2 })], 1, { state: "done", result: "수정 완료" }, at)[0]).toMatchObject({ rev: 1, fixOpen: 0, reportedAt: at });
    expect(getCardItemDisplay(reportCardItem([item({ state: "doing", reopened: "사용자 요청" })], 1, { state: "done", result: "수정 완료" }, at)[0]!)).toBe("changed");
  });
});

describe("user confirmation and comment fixes", () => {
  it("records the confirmed revision and unconfirms without changing item state", () => {
    const current = [item({ state: "doing", rev: 2 })];
    const confirmed = confirmCardItem(current, 1, true, at);
    expect(confirmed[0]).toMatchObject({ state: "doing", confirmed: { at, rev: 2 }, reopened: null, fixOpen: 0 });
    expect(confirmCardItem(confirmed, 1, false, at)[0]).toMatchObject({ state: "doing", confirmed: null });
    const manyConfirmed = Array.from({ length: 7 }, (_, i) => item({ id: i + 1, confirmed: { at, rev: 0 } }));
    expect(confirmCardItem(manyConfirmed, 1, false, at)).toHaveLength(7);
  });

  it("opens a fix by clearing confirmation and incrementing fixOpen", () => {
    const result = openCardItemFix([item({ state: "doing", confirmed: { at, rev: 0 }, reopened: "기존 사유" })], 1);
    expect(result[0]).toMatchObject({ state: "doing", confirmed: null, fixOpen: 1, reopened: "기존 사유" });
    expect(getCardItemDisplay(result[0]!)).toBe("fix");
  });
});

describe("short visible card text", () => {
  it("counts Unicode code points and includes the current count in length errors", () => {
    expect(codePointLength("😀한글")).toBe(3);
    expect(assertShortCardText("title", "😀".repeat(40), 40)).toBe("😀".repeat(40));
    expectInvalid(() => assertShortCardText("title", "😀".repeat(41), 40), "title은 40자까지입니다. 지금 41자입니다");
    expect(assertShortCardText("title", "한국어", 3)).toBe("한국어");
  });

  it.each([
    "31801b85를 반영했습니다",
    "a6a5f800-721e-46b9-a664-60ba765c3cd6",
    "src/cards/card_prompt.ts",
    "C:\\src\\card.ts",
    "docs/설명.md",
    "https://example.com",
    "[자료](https://example.com)",
  ])("rejects identifiers and links in visible text: %s", (text) => {
    expectInvalid(() => assertShortCardText("title", text, 100), "식별자는 노트에 적으세요(add_card_note). 링크는 증거에 다세요");
  });

  it.each([
    ["result", "https://example.com", 80],
    ["caveat", "src/cards/card_prompt.ts", 60],
    ["reopen_reason", "31801b85를 반영했습니다", 80],
    ["evidence.label", "a6a5f800-721e-46b9-a664-60ba765c3cd6", 40],
    ["now", "docs/설명.md", 60],
    ["ask", "www.example.com", 60],
  ] as const)("checks identifiers in %s", (field, text, max) => {
    expectInvalid(() => assertShortCardText(field, text, max), "식별자는 노트에 적으세요(add_card_note). 링크는 증거에 다세요");
  });

  it.each(["PR #1193을 확인했습니다", "2026-10-05 20:30에 확인했습니다", "1234567", "abcdefg", "아직 확인하지 못했습니다"]) (
    "allows ordinary short text: %s",
    (text) => expect(assertShortCardText("title", text, 100)).toBe(text),
  );

  it("requires text for mandatory visible fields", () => {
    expectInvalid(() => assertShortCardText("title", "  ", 40), "title은 비워 둘 수 없습니다");
    expectInvalid(() => assertShortCardText("result", "", 80), "result은 비워 둘 수 없습니다");
  });
});

describe("card now projections", () => {
  it("requires ask for a user turn and stores the supplied session", () => {
    expect(makeCardNow({ text: "다음 결과를 확인합니다", turn: "agent" }, at, "session-1")).toEqual({
      text: "다음 결과를 확인합니다", turn: "agent", ask: null, updatedAt: at, sessionId: "session-1",
    });
    expectInvalid(() => makeCardNow({ text: "확인 요청", turn: "user" }, at, "session-1"), "사용자가 볼 것을 ask에 한 줄로 적으세요");
    expect(makeCardNow({ text: "확인 요청", turn: "user", ask: "결과를 봐 주세요" }, at, null).sessionId).toBeNull();
  });

  it("moves review and question requests to the user turn without adding an update record", () => {
    const existing = { text: "진행 중", turn: "agent" as const, ask: null, updatedAt: at, sessionId: "session-1" };
    expect(reviewCardNow(existing, "결과를 확인해 주세요", at, "session-2")).toMatchObject({
      text: "진행 중", turn: "user", ask: "결과를 확인해 주세요", updatedAt: at, sessionId: "session-2",
    });
    expect(reviewCardNow(null, "결과를 확인해 주세요", at, null)?.text).toBe("결과를 확인해 주세요");
    expect(questionCardNow(null, "추가 질문", at, "session-1")).toBeNull();
    expect(questionCardNow(existing, "추가 질문", at, "session-1")).toMatchObject({ turn: "user", ask: "추가 질문" });
    expect(questionCardNow(existing, "가".repeat(60) + "나", at, "session-1")?.ask).toBe("가".repeat(59) + "…");
  });
});
