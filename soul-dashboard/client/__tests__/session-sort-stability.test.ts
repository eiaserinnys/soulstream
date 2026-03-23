/**
 * session-sort-stability.test.ts
 *
 * session_updated SSE 이벤트에 updated_at/status가 없을 때
 * 기존 값이 undefined로 덮어씌워져 정렬이 흔들리는 버그를 검증한다.
 *
 * 버그 재현:
 * - emit_read_position_updated(서버)가 updated_at/status 없이 session_updated 발행
 * - 클라이언트가 updatedAt: undefined로 덮어씀
 * - 정렬 시 createdAt으로 폴백 → 세션이 목록 아래로 밀림
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import type { SessionSummary, SessionStreamEvent, SessionStatus } from "@seosoyoung/soul-ui";

/** 테스트용 세션 팩토리 */
function makeSession(
  overrides: Partial<SessionSummary> & { agentSessionId: string },
): SessionSummary {
  return {
    status: "running" as SessionStatus,
    eventCount: 0,
    lastEventId: 0,
    lastReadEventId: 0,
    ...overrides,
  };
}

/**
 * useSessionListProvider의 handleSSEEvent 로직을 재현한다.
 * 실제 훅은 React 컨텍스트가 필요하므로, 핸들러 로직만 추출하여 테스트한다.
 */
function applySessionUpdatedEvent(event: SessionStreamEvent) {
  const { updateSession } = useDashboardStore.getState();

  if (event.type !== "session_updated") return;

  const updates: Parameters<typeof updateSession>[1] = {};
  if (event.status != null) {
    updates.status = event.status as SessionStatus;
  }
  if (event.updated_at != null) {
    updates.updatedAt = event.updated_at;
  }
  if (event.last_message) {
    updates.lastMessage = {
      type: event.last_message.type,
      preview: event.last_message.preview,
      timestamp: event.last_message.timestamp,
    };
  }
  if (event.last_event_id != null) {
    updates.lastEventId = event.last_event_id;
  }
  if (event.last_read_event_id != null) {
    updates.lastReadEventId = event.last_read_event_id;
  }
  updateSession(event.agent_session_id, updates);
}

describe("세션 정렬 안정성 - session_updated 이벤트의 undefined 필드 처리", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  it("updated_at이 없는 session_updated 이벤트가 기존 updatedAt을 보존해야 한다", () => {
    // 세션 2개: A는 최근에 업데이트됨 (updatedAt이 더 최근)
    const sessionA = makeSession({
      agentSessionId: "A",
      createdAt: "2026-03-23T07:00:00Z",
      updatedAt: "2026-03-23T08:00:00Z",
    });
    const sessionB = makeSession({
      agentSessionId: "B",
      createdAt: "2026-03-23T07:30:00Z",
      updatedAt: "2026-03-23T07:50:00Z",
    });

    useDashboardStore.getState().setSessions([sessionA, sessionB]);

    // 정렬: A(08:00) > B(07:50) → A가 먼저
    let sessions = useDashboardStore.getState().sessions;
    expect(sessions[0].agentSessionId).toBe("A");

    // read_position_updated를 시뮬레이션: updated_at과 status가 없음
    applySessionUpdatedEvent({
      type: "session_updated",
      agent_session_id: "A",
      last_event_id: 10,
      last_read_event_id: 10,
    } as SessionStreamEvent);

    // A의 updatedAt이 보존되어 여전히 맨 위에 있어야 함
    sessions = useDashboardStore.getState().sessions;
    const a = sessions.find((s) => s.agentSessionId === "A")!;
    expect(a.updatedAt).toBe("2026-03-23T08:00:00Z");
    expect(sessions[0].agentSessionId).toBe("A");
  });

  it("status가 없는 session_updated 이벤트가 기존 status를 보존해야 한다", () => {
    const session = makeSession({
      agentSessionId: "A",
      status: "running" as SessionStatus,
      updatedAt: "2026-03-23T08:00:00Z",
    });

    useDashboardStore.getState().setSessions([session]);

    // read_position_updated 시뮬레이션: status 없음
    applySessionUpdatedEvent({
      type: "session_updated",
      agent_session_id: "A",
      last_event_id: 5,
      last_read_event_id: 5,
    } as SessionStreamEvent);

    const a = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "A")!;
    expect(a.status).toBe("running");
  });

  it("updated_at과 status가 있는 정상 이벤트는 값을 갱신해야 한다", () => {
    const session = makeSession({
      agentSessionId: "A",
      status: "running" as SessionStatus,
      updatedAt: "2026-03-23T07:00:00Z",
    });

    useDashboardStore.getState().setSessions([session]);

    // 정상 session_updated: 모든 필드 포함
    applySessionUpdatedEvent({
      type: "session_updated",
      agent_session_id: "A",
      status: "completed",
      updated_at: "2026-03-23T08:30:00Z",
      last_event_id: 20,
      last_read_event_id: 20,
    } as SessionStreamEvent);

    const a = useDashboardStore.getState().sessions.find((s) => s.agentSessionId === "A")!;
    expect(a.status).toBe("completed");
    expect(a.updatedAt).toBe("2026-03-23T08:30:00Z");
  });
});
