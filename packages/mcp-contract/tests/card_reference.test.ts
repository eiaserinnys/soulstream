import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  REFERENCE_ARGUMENT_SLOTS,
  callWithReferenceTranslation,
  formatCardReference,
  parseCardReference,
  type CardReferenceLookup,
  type CardReferenceLookupResult,
} from "../src/card_reference.ts";
import type { CallToolResult } from "../src/result.ts";

const OK: CallToolResult = { content: [{ type: "text", text: "본문" }], structuredContent: { done: true } };

function resolved(table: Record<string, CardReferenceLookupResult>) {
  const calls: string[][] = [];
  const lookup: CardReferenceLookup = async refs => {
    calls.push(refs);
    return refs.map(ref => table[ref] ?? { ref, error: `${ref} 번호의 카드가 없습니다.` });
  };
  return { lookup, calls };
}
function recorder(result: CallToolResult = OK) {
  const received: Record<string, unknown>[] = [];
  return { received, call: async (args: Record<string, unknown>) => { received.push(args); return result; } };
}
const CARD = { ref: "#412", kind: "card", id: "card-uuid-412", title: "퍼시스턴트 에이전트 세션" } as const;
const SESSION = { ref: "#412.s2", kind: "session", id: "session-uuid-2", title: "🔨 P6 체크포인트 조립" } as const;

test("grammar accepts card and child references and trims outer whitespace", () => {
  assert.deepEqual(parseCardReference("#412"), { cardNumber: 412, kind: "card", ordinal: null });
  assert.deepEqual(parseCardReference("#412.s2"), { cardNumber: 412, kind: "session", ordinal: 2 });
  assert.deepEqual(parseCardReference("#412.r1"), { cardNumber: 412, kind: "report", ordinal: 1 });
  assert.deepEqual(parseCardReference("#412.q1"), { cardNumber: 412, kind: "question", ordinal: 1 });
  assert.deepEqual(parseCardReference("#412.c3"), { cardNumber: 412, kind: "comment", ordinal: 3 });
  assert.deepEqual(parseCardReference("  #412.s2\n"), { cardNumber: 412, kind: "session", ordinal: 2 });
  assert.deepEqual(parseCardReference("#999999999"), { cardNumber: 999999999, kind: "card", ordinal: null });
  assert.deepEqual(parseCardReference("#1.s999999"), { cardNumber: 1, kind: "session", ordinal: 999999 });
});

test("grammar rejects every other shape", () => {
  for (const text of ["", "#", "412", "# 412", "#0", "#012", "#412.S2", "#412.s", "#412.s0", "#412.s02", "#412.x1",
    "#412.s2.s3", "#412 .s2", "#1000000000", "#1.s1000000", "#-1", "#4.5", "abc-uuid"])
    assert.equal(parseCardReference(text), null, JSON.stringify(text));
});

test("format and parse round-trip", () => {
  assert.equal(formatCardReference(412), "#412");
  assert.equal(formatCardReference(412, { kind: "session", ordinal: 2 }), "#412.s2");
  assert.equal(formatCardReference(7, { kind: "report", ordinal: 1 }), "#7.r1");
  assert.equal(formatCardReference(7, { kind: "question", ordinal: 12 }), "#7.q12");
  assert.equal(formatCardReference(7, { kind: "comment", ordinal: 3 }), "#7.c3");
  for (const text of ["#412", "#412.s2", "#412.r1", "#412.q10", "#412.c3"]) {
    const parsed = parseCardReference(text)!;
    assert.equal(formatCardReference(parsed.cardNumber, parsed.ordinal === null ? undefined
      : { kind: parsed.kind as "session" | "report" | "question" | "comment", ordinal: parsed.ordinal }), text);
  }
});

test("argument slots name only card and session identifier arguments", () => {
  assert.deepEqual({ ...REFERENCE_ARGUMENT_SLOTS }, {
    card_id: "card", after_card_id: "card",
    session_id: "session", target_session_id: "session", predecessor_session_id: "session",
    session_ids: "session", "assignee.session_id": "session",
  });
});

test("a call without a '#' value is untouched: no lookup, same args object, same result object", async () => {
  const { lookup, calls } = resolved({});
  const seen: Record<string, unknown>[] = [];
  const result: CallToolResult = { content: [{ type: "text", text: "그대로" }] };
  const args = { card_id: "9f3e1c2a-0000-4000-8000-000000000000", session_id: "abc", text: "#412 는 본문", caller_session_id: "#7",
    session_ids: ["s1", "s2"], assignee: { kind: "session", session_id: "s3" } };
  const returned = await callWithReferenceTranslation(args, lookup, async a => { seen.push(a); return result; });
  assert.equal(returned, result);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], args);
  assert.equal(calls.length, 0);
  const rejected: Record<string, unknown>[] = [];
  const again = await callWithReferenceTranslation(args, lookup, async a => { rejected.push(a); return result; }, { rejectReferences: true });
  assert.equal(again, result);
  assert.equal(rejected[0], args);
  assert.equal(calls.length, 0);
});

test("only identifier slots are translated; body arguments and caller_session_id stay as written", async () => {
  const { lookup, calls } = resolved({ "#412": CARD });
  const { call, received } = recorder();
  const args = { card_id: "#412", title: "#99 제목", text: "#412.s9 본문", message: "#5", caller_session_id: "#7", folder_id: "#3" };
  await callWithReferenceTranslation(args, lookup, call);
  assert.deepEqual(calls, [["#412"]]);
  assert.deepEqual(received[0], { ...args, card_id: "card-uuid-412" });
  assert.equal(args.card_id, "#412");
});

test("session slots, session_ids elements and assignee.session_id are translated", async () => {
  const { lookup, calls } = resolved({ "#412": CARD, "#412.s2": SESSION,
    "#9.s1": { ref: "#9.s1", kind: "session", id: "session-uuid-9", title: "다른 세션" } });
  const { call, received } = recorder();
  await callWithReferenceTranslation({
    card_id: "#412", after_card_id: "plain-card-id", session_id: "#412.s2", target_session_id: "plain-session",
    predecessor_session_id: " #412.s2 ", session_ids: ["#412.s2", "plain-2", "#9.s1"], assignee: { kind: "session", session_id: "#9.s1" },
  }, lookup, call);
  assert.deepEqual(calls, [["#412", "#412.s2", "#9.s1"]]);
  assert.deepEqual(received[0], {
    card_id: "card-uuid-412", after_card_id: "plain-card-id", session_id: "session-uuid-2", target_session_id: "plain-session",
    predecessor_session_id: "session-uuid-2", session_ids: ["session-uuid-2", "plain-2", "session-uuid-9"],
    assignee: { kind: "session", session_id: "session-uuid-9" },
  });
});

test("the header lists each translated reference once and precedes the unchanged result", async () => {
  const { lookup } = resolved({ "#412": CARD, "#412.s2": SESSION });
  const { call } = recorder();
  const result = await callWithReferenceTranslation({ card_id: "#412", session_id: "#412.s2", target_session_id: "#412.s2" }, lookup, call);
  assert.deepEqual(result.content, [
    { type: "text", text: "번호 참조 #412 → 카드 「퍼시스턴트 에이전트 세션」\n번호 참조 #412.s2 → 세션 「🔨 P6 체크포인트 조립」" },
    { type: "text", text: "본문" },
  ]);
  assert.deepEqual(result.structuredContent, { done: true });
  assert.equal(result.isError, undefined);
});

test("the header is also attached when the tool ends with an error", async () => {
  const { lookup } = resolved({ "#412": CARD });
  const failed: CallToolResult = { isError: true, content: [{ type: "text", text: "실패" }], structuredContent: { error: "실패" } };
  const result = await callWithReferenceTranslation({ card_id: "#412" }, lookup, recorder(failed).call);
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0]!.text, "번호 참조 #412 → 카드 「퍼시스턴트 에이전트 세션」");
  assert.equal(result.content[1]!.text, "실패");
  assert.deepEqual(result.structuredContent, { error: "실패" });
});

test("syntax errors stop before lookup and call", async () => {
  const { lookup, calls } = resolved({});
  const { call, received } = recorder();
  const result = await callWithReferenceTranslation({ card_id: "#412.x1" }, lookup, call);
  assert.equal(result.isError, true);
  assert.equal(result.content[0]!.text, '번호 참조 문법이 아닙니다: "#412.x1". 카드는 #412, 카드에 붙은 세션은 #412.s2처럼 적습니다.');
  assert.equal(calls.length, 0);
  assert.equal(received.length, 0);
});

test("a reference of the wrong kind for its slot is rejected", async () => {
  const { lookup, calls } = resolved({});
  const { call, received } = recorder();
  const onCard = await callWithReferenceTranslation({ card_id: "#412.s2" }, lookup, call);
  assert.equal(onCard.content[0]!.text, "card_id에는 카드 번호(#412)를 적습니다. 받은 값: #412.s2");
  const onSession = await callWithReferenceTranslation({ session_id: "#412" }, lookup, call);
  assert.equal(onSession.content[0]!.text, "session_id에는 카드에 붙은 세션 번호(#412.s2)를 적습니다. 받은 값: #412");
  const onTarget = await callWithReferenceTranslation({ target_session_id: "#412" }, lookup, call);
  assert.equal(onTarget.content[0]!.text, "target_session_id에는 카드에 붙은 세션 번호(#412.s2)를 적습니다. 받은 값: #412");
  assert.equal(onCard.isError && onSession.isError && onTarget.isError, true);
  assert.equal(calls.length, 0);
  assert.equal(received.length, 0);
});

test("report, question and comment references have no argument slot anywhere", async () => {
  const { lookup, calls } = resolved({});
  const { call, received } = recorder();
  for (const [args, ref] of [[{ card_id: "#412.r1" }, "#412.r1"], [{ session_id: "#412.q1" }, "#412.q1"],
    [{ session_ids: ["#412.c3"] }, "#412.c3"], [{ assignee: { session_id: "#412.r1" } }, "#412.r1"]] as const) {
    const result = await callWithReferenceTranslation(args, lookup, call);
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, `보고, 질문, 커멘트 번호(${ref})를 받는 도구 인자는 없습니다.`);
  }
  assert.equal(calls.length, 0);
  assert.equal(received.length, 0);
});

test("an unresolved reference returns the lookup's own message without calling the tool", async () => {
  const { lookup } = resolved({});
  const { call, received } = recorder();
  const result = await callWithReferenceTranslation({ card_id: "#9999" }, lookup, call);
  assert.equal(result.isError, true);
  assert.equal(result.content[0]!.text, "#9999 번호의 카드가 없습니다.");
  assert.equal(received.length, 0);
});

test("a failing lookup becomes an error result and the tool is not called", async () => {
  const { call, received } = recorder();
  const failing: CardReferenceLookup = async () => { throw new Error("404 unknown operation"); };
  const result = await callWithReferenceTranslation({ card_id: "#412" }, failing, call);
  assert.equal(result.isError, true);
  assert.equal(result.content[0]!.text, "번호 참조를 해석하지 못했습니다: 404 unknown operation. 전체 ID로 다시 호출할 수 있습니다.");
  assert.equal(received.length, 0);
});

test("destructive tools refuse references without lookup or call", async () => {
  const { lookup, calls } = resolved({ "#412.s2": SESSION });
  const { call, received } = recorder();
  const result = await callWithReferenceTranslation({ session_id: "#412.s2" }, lookup, call, { rejectReferences: true });
  assert.equal(result.isError, true);
  assert.equal(result.content[0]!.text, "지우는 도구는 번호 참조를 받지 않습니다. 전체 ID로 부릅니다. 받은 값: #412.s2");
  assert.equal(calls.length, 0);
  assert.equal(received.length, 0);
});
