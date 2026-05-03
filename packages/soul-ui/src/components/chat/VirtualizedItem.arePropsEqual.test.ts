/**
 * VirtualizedItem.arePropsEqual — 순수 함수 단위 테스트
 *
 * lib/grouping.ts groupMessages가 매번 새 wrapper 객체를 만들어 memo의 기본
 * shallow compare가 항상 fail하는 결함을 막기 위한 비교 함수.
 *
 * 검증 매트릭스:
 *   - single: msg reference 동일성
 *   - tool-group: messages 배열 element-wise 비교
 *   - llmContext / sessionId 변화 감지
 *   - type 변화 감지 (single ↔ tool-group)
 */

import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { LlmContext } from "./hooks";
import { arePropsEqual } from "./VirtualizedItem";

function makeMsg(treeNodeId: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return {
    treeNodeId,
    eventId: 1,
    role,
    content: "x",
    treeNodeType: "user_message",
  } as unknown as ChatMessage;
}

describe("VirtualizedItem.arePropsEqual — single", () => {
  it("같은 msg reference + 같은 컨텍스트 → true", () => {
    const msg = makeMsg("a");
    const llmContext = { foo: 1 } as unknown as LlmContext;
    expect(
      arePropsEqual(
        { item: { type: "single", msg }, llmContext, sessionId: "s1" },
        { item: { type: "single", msg }, llmContext, sessionId: "s1" },
      ),
    ).toBe(true);
  });

  it("같은 내용이지만 다른 msg reference → false", () => {
    const m1 = makeMsg("a");
    const m2 = makeMsg("a"); // 같은 treeNodeId, 다른 reference
    expect(
      arePropsEqual(
        { item: { type: "single", msg: m1 } },
        { item: { type: "single", msg: m2 } },
      ),
    ).toBe(false);
  });

  it("llmContext reference 변경 → false", () => {
    const msg = makeMsg("a");
    const c1 = {} as unknown as LlmContext;
    const c2 = {} as unknown as LlmContext;
    expect(
      arePropsEqual(
        { item: { type: "single", msg }, llmContext: c1 },
        { item: { type: "single", msg }, llmContext: c2 },
      ),
    ).toBe(false);
  });

  it("sessionId 변경 → false", () => {
    const msg = makeMsg("a");
    expect(
      arePropsEqual(
        { item: { type: "single", msg }, sessionId: "s1" },
        { item: { type: "single", msg }, sessionId: "s2" },
      ),
    ).toBe(false);
  });
});

describe("VirtualizedItem.arePropsEqual — tool-group", () => {
  it("같은 messages 배열의 element references → true (배열은 wrapper 생성으로 다른 reference여도 OK)", () => {
    const a = makeMsg("a", "tool");
    const b = makeMsg("b", "tool");
    expect(
      arePropsEqual(
        { item: { type: "tool-group", messages: [a, b] } },
        { item: { type: "tool-group", messages: [a, b] } },
      ),
    ).toBe(true);
  });

  it("messages 길이 다름 → false", () => {
    const a = makeMsg("a", "tool");
    const b = makeMsg("b", "tool");
    expect(
      arePropsEqual(
        { item: { type: "tool-group", messages: [a, b] } },
        { item: { type: "tool-group", messages: [a] } },
      ),
    ).toBe(false);
  });

  it("element 한 개라도 다른 reference → false (라이브 SSE에서 새 ChatMessage가 합류한 경우)", () => {
    const a1 = makeMsg("a", "tool");
    const a2 = makeMsg("a", "tool"); // 같은 treeNodeId, 다른 reference
    const b = makeMsg("b", "tool");
    expect(
      arePropsEqual(
        { item: { type: "tool-group", messages: [a1, b] } },
        { item: { type: "tool-group", messages: [a2, b] } },
      ),
    ).toBe(false);
  });
});

describe("VirtualizedItem.arePropsEqual — type 변화", () => {
  it("single → tool-group 전환 → false", () => {
    const msg = makeMsg("a");
    const tool = makeMsg("a", "tool");
    expect(
      arePropsEqual(
        { item: { type: "single", msg } },
        { item: { type: "tool-group", messages: [tool] } },
      ),
    ).toBe(false);
  });

  it("tool-group → single 전환 → false", () => {
    const tool = makeMsg("a", "tool");
    const msg = makeMsg("a");
    expect(
      arePropsEqual(
        { item: { type: "tool-group", messages: [tool] } },
        { item: { type: "single", msg } },
      ),
    ).toBe(false);
  });
});
