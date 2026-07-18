/**
 * session-stream-dispatch 순수 함수 테스트.
 *
 * useSessionStreamSSE의 핵심 책임 두 가지를 hook 우회 없이 검증한다:
 *   1) 타입별 dispatch 라우팅 (특히 신규 stream_meta / replay_gap)
 *   2) SSE MessageEvent.lastEventId 페이로드 주입 (빈 문자열 → undefined 정규화)
 *
 * 이 두 함수는 useSessionStreamSSE가 EventSource 콜백 안에서 직접 사용한다.
 */

import { describe, it, expect, vi } from "vitest";
import {
  dispatchSessionStreamEvent,
  parseStreamMessage,
  type SessionStreamHandlers,
} from "./session-stream-dispatch";
import type {
  ReplayGapStreamEvent,
  SessionCreatedStreamEvent,
  SessionStreamEvent,
  StreamMetaStreamEvent,
} from "../shared/stream-events";

function makeHandlers(): SessionStreamHandlers & {
  __spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const spies = {
    onSessionList: vi.fn(),
    onSessionCreated: vi.fn(),
    onSessionUpdated: vi.fn(),
    onSessionDeleted: vi.fn(),
    onCatalogUpdated: vi.fn(),
    onMetadataUpdated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onCustomViewUpdated: vi.fn(),
    onPageUpdated: vi.fn(),
    onStreamMeta: vi.fn(),
    onReplayGap: vi.fn(),
    onEvent: vi.fn(),
  };
  return { ...spies, __spies: spies };
}

describe("dispatchSessionStreamEvent", () => {
  it("stream_meta 이벤트는 onStreamMeta 핸들러로 라우팅된다", () => {
    const handlers = makeHandlers();
    const event: StreamMetaStreamEvent = {
      type: "stream_meta",
      instance_id: "orch-A",
      latest_id: 42,
    };

    dispatchSessionStreamEvent(event, handlers);

    expect(handlers.__spies.onStreamMeta).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onStreamMeta).toHaveBeenCalledWith(event);
    expect(handlers.__spies.onSessionList).not.toHaveBeenCalled();
    expect(handlers.__spies.onReplayGap).not.toHaveBeenCalled();
    expect(handlers.__spies.onEvent).toHaveBeenCalledWith(event);
  });

  it("replay_gap 이벤트는 onReplayGap 핸들러로 라우팅된다", () => {
    const handlers = makeHandlers();
    const event: ReplayGapStreamEvent = {
      type: "replay_gap",
      latest_id: 100,
      instance_id: "orch-A",
    };

    dispatchSessionStreamEvent(event, handlers);

    expect(handlers.__spies.onReplayGap).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onReplayGap).toHaveBeenCalledWith(event);
    expect(handlers.__spies.onStreamMeta).not.toHaveBeenCalled();
    expect(handlers.__spies.onEvent).toHaveBeenCalledWith(event);
  });

  it("핸들러가 미제공이면 silent skip (throw 없음)", () => {
    const event: StreamMetaStreamEvent = {
      type: "stream_meta",
      instance_id: "orch-A",
      latest_id: 0,
    };

    expect(() => dispatchSessionStreamEvent(event, {})).not.toThrow();
  });

  it("기존 이벤트와 task/custom_view/page 업데이트도 그대로 라우팅", () => {
    const handlers = makeHandlers();
    const events: SessionStreamEvent[] = [
      { type: "session_list", sessions: [], total: 0 },
      {
        type: "session_created",
        session: { agentSessionId: "s1" } as never,
      },
      {
        type: "session_updated",
        agent_session_id: "s1",
        status: "running" as never,
        updated_at: "2026-01-01",
      },
      { type: "session_deleted", agent_session_id: "s1" },
      { type: "catalog_updated", catalog: { folders: [], sessions: {} } as never },
      {
        type: "metadata_updated",
        session_id: "s1",
        entry: {} as never,
        metadata: [],
      },
      {
        type: "task_updated",
        taskId: "rb-1",
        boardItemId: "task:rb-1",
      },
      {
        type: "custom_view_updated",
        customViewId: "cv-1",
        boardItemId: "custom_view:cv-1",
        revision: 2,
      },
      { type: "page_updated", page_id: "page-1", version: 7 },
    ];

    for (const event of events) {
      dispatchSessionStreamEvent(event, handlers);
    }

    expect(handlers.__spies.onSessionList).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onSessionCreated).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onSessionUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onSessionDeleted).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onCatalogUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onMetadataUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onTaskUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onCustomViewUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onPageUpdated).toHaveBeenCalledTimes(1);
    expect(handlers.__spies.onEvent).toHaveBeenCalledTimes(events.length);
    // stream_meta/replay_gap은 호출되지 않아야 함
    expect(handlers.__spies.onStreamMeta).not.toHaveBeenCalled();
    expect(handlers.__spies.onReplayGap).not.toHaveBeenCalled();
  });

  it("runbook_updated 읽기 호환 이벤트를 canonical task_updated로 한 번만 전달", () => {
    const handlers = makeHandlers();

    dispatchSessionStreamEvent(
      {
        type: "runbook_updated",
        runbookId: "rb-legacy",
        boardItemId: "runbook:opaque-id",
        lastEventId: "19",
      },
      handlers,
    );

    const canonical = {
      type: "task_updated",
      taskId: "rb-legacy",
      boardItemId: "runbook:opaque-id",
      lastEventId: "19",
    };
    expect(handlers.__spies.onTaskUpdated).toHaveBeenCalledOnce();
    expect(handlers.__spies.onTaskUpdated).toHaveBeenCalledWith(canonical);
    expect(handlers.__spies.onEvent).toHaveBeenCalledOnce();
    expect(handlers.__spies.onEvent).toHaveBeenCalledWith(canonical);
  });
});

describe("parseStreamMessage — SSE id 주입", () => {
  it("SSE id가 비어있지 않으면 lastEventId 필드로 주입한다", () => {
    const raw = JSON.stringify({
      type: "session_created",
      session: { agentSessionId: "s1" },
    });

    const result = parseStreamMessage(raw, "42") as SessionCreatedStreamEvent;

    expect(result.type).toBe("session_created");
    expect(result.lastEventId).toBe("42");
  });

  it("SSE id가 빈 문자열이면 undefined로 정규화한다 (NaN 오염 회피)", () => {
    const raw = JSON.stringify({
      type: "stream_meta",
      instance_id: "orch-A",
      latest_id: 0,
    });

    const result = parseStreamMessage(raw, "") as StreamMetaStreamEvent & {
      lastEventId?: string;
    };

    expect(result.type).toBe("stream_meta");
    expect(result.lastEventId).toBeUndefined();
  });

  it("JSON 파싱 실패 시 null을 반환한다 (호출자 silent skip 가능)", () => {
    const result = parseStreamMessage("not-json", "1");

    expect(result).toBeNull();
  });

  it("기존 데이터 필드는 보존된다 (스프레드)", () => {
    const raw = JSON.stringify({
      type: "session_updated",
      agent_session_id: "s1",
      status: "running",
      updated_at: "2026-01-01",
    });

    const result = parseStreamMessage(raw, "99");

    expect(result).toMatchObject({
      type: "session_updated",
      agent_session_id: "s1",
      status: "running",
      updated_at: "2026-01-01",
      lastEventId: "99",
    });
  });
});
