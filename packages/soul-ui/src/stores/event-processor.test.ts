/**
 * event-processor — dedup 동작 테스트.
 *
 * Phase 2-A 평탄화 후 (atom 260507.01.fe-tree-flattening):
 *   historyMode 분기 폐기로 모든 배치에서 lastEventId 이하 이벤트는 일관 dedup 차단된다.
 *   배치 내 중복 eventId는 placeInTree의 nodeMap.has 가드가 silent skip한다.
 */

import { describe, it, expect } from "vitest";
import { processEventsBatch, processEventSingle } from "./event-processor";
import { createProcessingContext } from "./processing-context";
import type { SoulSSEEvent } from "@shared/types";
import { flattenTree } from "../lib/flatten-tree";

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
  it("lastEventId 이하 이벤트를 차단 (모든 배치 일관 적용)", () => {
    const ctx = createProcessingContext();

    const events = [
      makeUserMessageEvent(5),  // <= lastEventId(10) → 차단
      makeUserMessageEvent(11), // > lastEventId(10) → 처리
    ];

    const result = processEventsBatch(events, ctx, null, "sess-1", null, 10);

    // 11만 트리에 추가됨, 5는 dedup으로 차단
    expect(result.updated).toBe(true);
    expect(result.maxEventId).toBe(11);
    expect(ctx.nodeMap.has("11")).toBe(true);
    expect(ctx.nodeMap.has("5")).toBe(false);
  });

  it("같은 배치 내 중복 eventId는 placeInTree silent skip 가드가 차단", () => {
    const ctx = createProcessingContext();

    const events = [
      makeUserMessageEvent(5),
      makeUserMessageEvent(5), // 같은 id 중복 — skip 가드가 두 번째 차단
    ];

    const result = processEventsBatch(events, ctx, null, "sess-1", null, 0);

    expect(result.updated).toBe(true);
    // 첫 번째만 등록, 두 번째는 placeInTree에서 skip
    expect(ctx.nodeMap.has("5")).toBe(true);
    // root.children에 user_message가 1개만 있어야 함 (평면 push)
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

describe("processEventsBatch — app-server final assistant message", () => {
  it("live final assistant_message replaces the streaming text node instead of creating a duplicate bubble", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        {
          event: {
            type: "text_start",
            timestamp: 1,
            tool_use_id: "item-1",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 0,
        },
        {
          event: {
            type: "text_delta",
            timestamp: 2,
            text: "Hel",
            tool_use_id: "item-1",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 0,
        },
        {
          event: {
            type: "text_delta",
            timestamp: 3,
            text: "lo",
            tool_use_id: "item-1",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 0,
        },
        {
          event: {
            type: "assistant_message",
            timestamp: 4,
            content: "Hello final",
            tool_use_id: "item-1",
            _final_for_live_stream: true,
          } as unknown as SoulSSEEvent,
          eventId: 10,
        },
        {
          event: {
            type: "text_end",
            timestamp: 4,
            tool_use_id: "item-1",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 0,
        },
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    const messages = flattenTree(result.root);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello final",
      isStreaming: false,
      treeNodeType: "text",
    });
    expect((result.root?.children ?? [])).toHaveLength(1);
  });

  it("history final assistant_message without a live stream creates one assistant message", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        {
          event: {
            type: "assistant_message",
            timestamp: 4,
            content: "Hello final",
            tool_use_id: "item-1",
            _final_for_live_stream: true,
          } as unknown as SoulSSEEvent,
          eventId: 10,
        },
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    const messages = flattenTree(result.root);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello final",
      treeNodeType: "assistant_message",
    });
  });

  it("history stream fragments loaded after the final assistant_message do not create a duplicate bubble", () => {
    const ctx = createProcessingContext();
    const first = processEventsBatch(
      [
        {
          event: {
            type: "assistant_message",
            timestamp: 4,
            content: "Hello final",
            tool_use_id: "item-1",
            _final_for_live_stream: true,
          } as unknown as SoulSSEEvent,
          eventId: 10,
        },
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
      true,
    );

    const second = processEventsBatch(
      [
        {
          event: {
            type: "text_start",
            timestamp: 1,
            tool_use_id: "item-1",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 1,
        },
        {
          event: {
            type: "text_delta",
            timestamp: 2,
            text: "Hello",
            tool_use_id: "item-1",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 2,
        },
        {
          event: {
            type: "text_end",
            timestamp: 3,
            tool_use_id: "item-1",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 3,
        },
      ],
      ctx,
      first.root,
      "sess-1",
      null,
      10,
      true,
    );

    const messages = flattenTree(second.root);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "Hello final",
      treeNodeType: "assistant_message",
    });
  });
});

describe("processEventsBatch — skipDedup (history prepend 경로)", () => {
  it("skipDedup=true: lastEventId 이하 과거 이벤트도 처리 (history prepend 의도)", () => {
    const ctx = createProcessingContext();

    const events = [
      makeUserMessageEvent(3),  // <= lastEventId(10), 차단되어선 안 됨
      makeUserMessageEvent(7),  // <= lastEventId(10), 차단되어선 안 됨
    ];

    const result = processEventsBatch(events, ctx, null, "sess-1", null, 10, true);

    expect(result.updated).toBe(true);
    // 두 이벤트 모두 nodeMap에 등록됨 (dedup 우회)
    expect(ctx.nodeMap.has("3")).toBe(true);
    expect(ctx.nodeMap.has("7")).toBe(true);
    // skipDedup이라도 maxEventId는 비교 ASC 갱신만 — caller(processHistoryEvents)가 Math.max로 보호
    expect(result.maxEventId).toBe(10);
  });

  it("skipDedup=true에서도 같은 배치 내 중복 eventId는 placeInTree 가드가 차단", () => {
    const ctx = createProcessingContext();

    const events = [
      makeUserMessageEvent(5),
      makeUserMessageEvent(5),
    ];

    const result = processEventsBatch(events, ctx, null, "sess-1", null, 0, true);

    expect(result.updated).toBe(true);
    expect(ctx.nodeMap.has("5")).toBe(true);
    const root = result.root;
    expect(root).not.toBeNull();
    const userMsgChildren = (root?.children ?? []).filter(
      (c) => c.type === "user_message",
    );
    expect(userMsgChildren.length).toBe(1);
  });

  it("skipDedup 기본값 false (라이브 SSE 경로)", () => {
    const ctx = createProcessingContext();

    const events = [
      makeUserMessageEvent(3),  // <= lastEventId(10) → 차단 (기본 동작)
      makeUserMessageEvent(11), // > lastEventId(10) → 처리
    ];

    // skipDedup 인자 미전달 — 기본값 false
    const result = processEventsBatch(events, ctx, null, "sess-1", null, 10);

    expect(result.updated).toBe(true);
    expect(ctx.nodeMap.has("11")).toBe(true);
    expect(ctx.nodeMap.has("3")).toBe(false); // dedup 차단
  });
});
