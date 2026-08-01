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

function makeAssistantMessageEvent(
  eventId: number,
  content: string,
): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "assistant_message",
      content,
      timestamp: eventId,
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeCompleteEvent(eventId: number): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "complete",
      result: "Turn completed",
      attachments: [],
    } as unknown as SoulSSEEvent,
    eventId,
  };
}

function makeTurnSummaryEvent(
  eventId: number,
  finalResponseEventId: number,
  content = "턴에서 결정한 내용을 요약했다.",
): { event: SoulSSEEvent; eventId: number } {
  return {
    event: {
      type: "turn_summary",
      content,
      turn_start_event_id: 101,
      final_response_event_id: finalResponseEventId,
      parent_event_id: finalResponseEventId,
      model: "gpt-5.6-terra",
      latency_ms: 800,
      attempts: 1,
      timestamp: eventId,
      unexpected_future_field: { safe: true },
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

  it("eventId 없는 live-only 이벤트는 lastEventId 커서를 되돌리지 않는다", () => {
    const ctx = createProcessingContext();

    const result = processEventSingle(
      {
        type: "text_start",
        timestamp: 0,
        tool_use_id: "item-live",
        _live_only: true,
      } as unknown as SoulSSEEvent,
      0,
      ctx,
      null,
      "sess-1",
      null,
      42,
    );

    expect(result.updated).toBe(true);
    expect(result.newLastEventId).toBe(42);
  });
});

describe("processEventSingle — history_sync reset compatibility", () => {
  it("reset_required를 모르는 웹도 트리를 바꾸지 않고 baseline marker로 처리", () => {
    const ctx = createProcessingContext();
    const initial = processEventSingle(
      makeUserMessageEvent(7).event,
      7,
      ctx,
      null,
      "sess-1",
      null,
      0,
    );
    const root = initial.root;

    const result = processEventSingle(
      {
        type: "history_sync",
        last_event_id: 99,
        is_live: true,
        reset_required: true,
      } as unknown as SoulSSEEvent,
      0,
      ctx,
      root,
      "sess-1",
      null,
      7,
    );

    expect(result.root).toBe(root);
    expect(result.updated).toBe(false);
    expect(result.notify).toBe(false);
    expect(result.isHistorySync).toBe(true);
    expect(ctx.historySynced).toBe(true);
    expect(flattenTree(result.root)).toHaveLength(flattenTree(root).length);
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

  it("id 없는 live-only text_start는 과거 이벤트보다 뒤에 붙는다", () => {
    const ctx = createProcessingContext();
    const base = processEventsBatch(
      [
        makeUserMessageEvent(10),
        {
          event: {
            type: "assistant_message",
            timestamp: 1,
            content: "Stored answer",
          } as unknown as SoulSSEEvent,
          eventId: 11,
        },
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    const live = processEventsBatch(
      [
        {
          event: {
            type: "text_start",
            timestamp: 2,
            tool_use_id: "item-live",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 0,
        },
        {
          event: {
            type: "text_delta",
            timestamp: 3,
            text: "Streaming",
            tool_use_id: "item-live",
            _live_only: true,
          } as unknown as SoulSSEEvent,
          eventId: 0,
        },
      ],
      ctx,
      base.root,
      "sess-1",
      null,
      11,
    );

    const children = live.root?.children ?? [];
    expect(children.map((child) => child.type)).toEqual([
      "user_message",
      "assistant_message",
      "text",
    ]);
    expect(children.at(-1)).toMatchObject({
      type: "text",
      content: "Streaming",
    });
    expect(live.maxEventId).toBe(11);
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

describe("turn_summary — 응답 anchor 직접 캡션 투영", () => {
  it("뒤 이벤트가 표시된 후 늦게 도착해도 final response 바로 뒤에 삽입한다", () => {
    const ctx = createProcessingContext();
    const initial = processEventsBatch(
      [
        makeAssistantMessageEvent(119, "최종 응답"),
        makeCompleteEvent(120),
        makeUserMessageEvent(130),
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );
    const before = flattenTree(initial.root);

    const late = processEventSingle(
      makeTurnSummaryEvent(140, 119).event,
      140,
      ctx,
      initial.root,
      "sess-1",
      null,
      130,
    );
    const after = flattenTree(late.root);

    expect(after.map((message) => message.treeNodeType)).toEqual([
      "assistant_message",
      "turn_summary",
      "complete",
      "user_message",
    ]);
    expect(after[1]).toMatchObject({
      role: "system",
      content: "턴에서 결정한 내용을 요약했다.",
      eventId: 140,
    });
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
    expect(after[3]).toBe(before[2]);
  });

  it("summary가 먼저 로드되면 숨고 anchor가 pagination으로 오면 같은 stable key로 결합한다", () => {
    const ctx = createProcessingContext();
    const latestPage = processEventsBatch(
      [
        makeUserMessageEvent(130),
        makeTurnSummaryEvent(140, 119),
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(flattenTree(latestPage.root).map((message) => message.treeNodeType)).toEqual([
      "user_message",
    ]);

    const olderPage = processEventsBatch(
      [
        makeAssistantMessageEvent(119, "최종 응답"),
        makeCompleteEvent(120),
      ],
      ctx,
      latestPage.root,
      "sess-1",
      null,
      140,
      true,
    );

    expect(flattenTree(olderPage.root).map((message) => message.treeNodeType)).toEqual([
      "assistant_message",
      "turn_summary",
      "complete",
      "user_message",
    ]);
  });

  it.each([
    {
      label: "intervention_sent",
      event: {
        type: "intervention_sent",
        user: "operator",
        text: "다음 턴 개입",
      },
      expectedType: "intervention",
    },
    {
      label: "session_notification",
      event: {
        type: "session_notification",
        delivery_id: "delivery-next",
        delivery_intent: "runtime_followup",
        source: "agent",
        text: "다음 턴 알림",
        disposition: "auto_resume",
      },
      expectedType: "session_notification",
    },
  ])("$label이 뒤에 있어도 summary는 final response 바로 뒤다", ({ event, expectedType }) => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        makeAssistantMessageEvent(119, "최종 응답"),
        makeCompleteEvent(120),
        { event: event as unknown as SoulSSEEvent, eventId: 130 },
        makeTurnSummaryEvent(140, 119),
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(flattenTree(result.root).map((message) => message.treeNodeType)).toEqual([
      "assistant_message",
      "turn_summary",
      "complete",
      expectedType,
    ]);
  });

  it("final이 미로딩이고 parent가 로딩됐으면 parent 바로 뒤에 렌더한다", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        makeAssistantMessageEvent(118, "parent 응답"),
        {
          event: {
            type: "turn_summary",
            content: "parent fallback 요약",
            final_response_event_id: 119,
            parent_event_id: 118,
          } as unknown as SoulSSEEvent,
          eventId: 140,
        },
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(flattenTree(result.root)).toEqual([
      expect.objectContaining({
        treeNodeType: "assistant_message",
        eventId: 118,
      }),
      expect.objectContaining({
        treeNodeType: "turn_summary",
        content: "parent fallback 요약",
      }),
    ]);
  });

  it("유효 anchor 후보가 없는 legacy만 자기 event ID 위치로 fail-open한다", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        makeUserMessageEvent(100),
        {
          event: {
            type: "turn_summary",
            content: "legacy 요약",
          } as unknown as SoulSSEEvent,
          eventId: 110,
        },
        makeAssistantMessageEvent(120, "후속 응답"),
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(flattenTree(result.root).map((message) => message.treeNodeType)).toEqual([
      "user_message",
      "turn_summary",
      "assistant_message",
    ]);
  });

  it("숫자 문자열 anchor는 유효한 safe integer가 아니므로 legacy 위치로 fail-open한다", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        makeAssistantMessageEvent(100, "앞 응답"),
        {
          event: {
            type: "turn_summary",
            content: "문자열 anchor 요약",
            final_response_event_id: "130",
            parent_event_id: "130",
          } as unknown as SoulSSEEvent,
          eventId: 110,
        },
        makeCompleteEvent(120),
        makeAssistantMessageEvent(130, "문자열이 가리킨 응답"),
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(flattenTree(result.root).map((message) => message.treeNodeType)).toEqual([
      "assistant_message",
      "turn_summary",
      "complete",
      "assistant_message",
    ]);
  });

  it("필수 필드가 없는 payload는 건너뛰고 같은 배치의 다음 이벤트를 처리한다", () => {
    const ctx = createProcessingContext();
    const result = processEventsBatch(
      [
        {
          event: {
            type: "turn_summary",
            model: "gpt-5.6-terra",
          } as unknown as SoulSSEEvent,
          eventId: 140,
        },
        makeUserMessageEvent(141),
      ],
      ctx,
      null,
      "sess-1",
      null,
      0,
    );

    expect(ctx.nodeMap.has("140")).toBe(false);
    expect(flattenTree(result.root).map((message) => message.treeNodeType)).toEqual([
      "user_message",
    ]);
    expect(result.maxEventId).toBe(141);
  });
});
