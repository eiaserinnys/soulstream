/**
 * event-processor — dedup 동작 테스트.
 *
 * 라이브 SSE는 lastEventId 이하 이벤트를 차단(중복 방지),
 * historyMode prepend는 의도적으로 과거 eventId를 처리(차단 우회).
 */

import { describe, it, expect } from "vitest";
import { processEventsBatch } from "./event-processor";
import { createProcessingContext } from "./processing-context";
import type { SoulSSEEvent } from "@shared/types";

function makeUserMessageEvent(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "user_message",
      text: `msg-${eventId}`,
      timestamp: 0,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

describe("processEventsBatch — dedup", () => {
  it("라이브 모드(historyMode=false): lastEventId 이하 이벤트를 차단", () => {
    const ctx = createProcessingContext();
    ctx.historyMode = false;

    const events = [
      makeUserMessageEvent(5),  // <= lastEventId(10) → 차단
      makeUserMessageEvent(11), // > lastEventId(10) → 처리
    ];

    const result = processEventsBatch(events, ctx, null, "sess-1", null, 10);

    // 11만 트리에 추가됨, 5는 dedup으로 차단
    expect(result.updated).toBe(true);
    expect(result.maxEventId).toBe(11);
    // ctx.nodeMap에 user-msg-11만 등록 (root + user-msg-11)
    expect(ctx.nodeMap.has("11")).toBe(true);
    expect(ctx.nodeMap.has("5")).toBe(false);
  });

  it("historyMode=true: lastEventId 이하 과거 이벤트도 처리 (prepend)", () => {
    const ctx = createProcessingContext();
    ctx.historyMode = true; // prepend 컨텍스트

    const events = [
      makeUserMessageEvent(3),  // <= lastEventId(10), 그러나 historyMode이므로 처리
      makeUserMessageEvent(7),  // <= lastEventId(10), 처리
    ];

    const result = processEventsBatch(events, ctx, null, "sess-1", null, 10);

    expect(result.updated).toBe(true);
    // historyMode에서는 maxEventId가 lastEventId보다 작아도 갱신 안 됨 (`>`만 비교)
    expect(result.maxEventId).toBe(10);
    // 두 이벤트 모두 nodeMap에 등록됨 (dedup 우회)
    expect(ctx.nodeMap.has("3")).toBe(true);
    expect(ctx.nodeMap.has("7")).toBe(true);
  });

  it("historyMode=true: 같은 배치 내 중복 eventId는 placeInTree skip 가드가 차단", () => {
    const ctx = createProcessingContext();
    ctx.historyMode = true;

    const events = [
      makeUserMessageEvent(5),
      makeUserMessageEvent(5), // 같은 id 중복 — skip 가드가 두 번째 차단
    ];

    const result = processEventsBatch(events, ctx, null, "sess-1", null, 0);

    expect(result.updated).toBe(true);
    // 첫 번째만 등록, 두 번째는 placeInTree에서 skip
    expect(ctx.nodeMap.has("5")).toBe(true);
    // root.children에 user_message가 1개만 있어야 함
    const root = result.root;
    expect(root).not.toBeNull();
    const userMsgChildren = (root?.children ?? []).filter(
      (c) => c.type === "user_message",
    );
    expect(userMsgChildren.length).toBe(1);
  });
});
