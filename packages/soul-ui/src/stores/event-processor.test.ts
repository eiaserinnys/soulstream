/**
 * event-processor — dedup 동작 테스트.
 *
 * 라이브 SSE는 lastEventId 이하 이벤트를 차단(중복 방지),
 * historyMode prepend는 의도적으로 과거 eventId를 처리(차단 우회).
 */

import { describe, it, expect } from "vitest";
import { processEventsBatch, processEventSingle } from "./event-processor";
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

function makePromptSuggestionEvent(
  eventId: number,
  text: string,
): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "prompt_suggestion",
      timestamp: 0,
      text,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeTextStartEvent(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "text_start",
      timestamp: 0,
      parent_event_id: undefined,
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

describe("processEventSingle — prompt_suggestion", () => {
  it("prompt_suggestion 단건: result.promptSuggestion에 sessionId+text가 담긴다", () => {
    const ctx = createProcessingContext();
    const result = processEventSingle(
      makePromptSuggestionEvent(11, "hello world").event,
      11,
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(result.promptSuggestion).toEqual({ sessionId: "sess-1", text: "hello world" });
    expect(result.updated).toBe(false);
    expect(result.root).toBeNull();
    expect(result.newLastEventId).toBe(11);
  });

  it("prompt_suggestion: activeSessionKey가 null이면 promptSuggestion=null", () => {
    const ctx = createProcessingContext();
    const result = processEventSingle(
      makePromptSuggestionEvent(11, "hello").event,
      11,
      ctx,
      null,
      null,
      null,
      0,
    );

    expect(result.promptSuggestion).toBeNull();
  });

  it("text_start 도착 시 result.clearPromptSuggestionFor에 sessionId가 담긴다", () => {
    const ctx = createProcessingContext();
    ctx.historySynced = true;
    const result = processEventSingle(
      makeTextStartEvent(12).event,
      12,
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(result.clearPromptSuggestionFor).toBe("sess-1");
  });

  it("user_message는 clearPromptSuggestionFor를 셋하지 않는다", () => {
    const ctx = createProcessingContext();
    ctx.historySynced = true;
    const result = processEventSingle(
      makeUserMessageEvent(13).event,
      13,
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    // null 또는 undefined 모두 falsy이면 OK
    expect(result.clearPromptSuggestionFor ?? null).toBeNull();
  });
});

describe("processEventsBatch — prompt_suggestion", () => {
  it("배치에 prompt_suggestion 1건: BatchResult.promptSuggestion에 sessionId+text", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [makePromptSuggestionEvent(11, "first")],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(result.promptSuggestion).toEqual({ sessionId: "sess-1", text: "first" });
    expect(result.clearPromptSuggestionFor).toBeNull();
  });

  it("배치에 prompt_suggestion 여러 건: later wins (마지막 값이 정본)", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        makePromptSuggestionEvent(11, "first"),
        makePromptSuggestionEvent(12, "second"),
        makePromptSuggestionEvent(13, "third"),
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(result.promptSuggestion).toEqual({ sessionId: "sess-1", text: "third" });
  });

  it("배치에 text_start가 포함되면 clearPromptSuggestionFor에 sessionId", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [makeTextStartEvent(11)],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(result.clearPromptSuggestionFor).toBe("sess-1");
  });

  it("배치에 text_start와 prompt_suggestion이 모두 있으면 둘 다 BatchResult에 담긴다 (dispatcher가 clear→set 순서로 적용)", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        makeTextStartEvent(10),               // clear 신호
        makePromptSuggestionEvent(20, "new"), // set 신호 (새 turn 직후)
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(result.clearPromptSuggestionFor).toBe("sess-1");
    expect(result.promptSuggestion).toEqual({ sessionId: "sess-1", text: "new" });
  });

  it("activeSessionKey가 null이면 promptSuggestion/clearPromptSuggestionFor 둘 다 null", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        makePromptSuggestionEvent(11, "hello"),
        makeTextStartEvent(12),
      ],
      ctx,
      null,
      null,
      null,
      0,
    );

    expect(result.promptSuggestion).toBeNull();
    expect(result.clearPromptSuggestionFor).toBeNull();
  });
});
