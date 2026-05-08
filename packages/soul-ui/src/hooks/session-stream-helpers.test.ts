/**
 * session-stream-helpers 테스트
 *
 * applySessionCreated/Updated/Deleted 순수 함수 검증.
 * node 환경에서 실행 (jsdom 불필요).
 */

import { describe, it, expect } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { SessionSummary } from "../shared/types";
import {
  applySessionCreated,
  applySessionUpdated,
  applySessionDeleted,
  buildSessionUpdates,
} from "./session-stream-helpers";
import type { SessionPage } from "./session-stream-helpers";
import type { SessionUpdatedStreamEvent } from "../shared/stream-events";

function makeSession(
  id: string,
  overrides?: Partial<SessionSummary>,
): SessionSummary {
  return {
    agentSessionId: id,
    sessionType: "task",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as SessionSummary;
}

function makeData(
  pages: Array<SessionSummary[]>,
): InfiniteData<SessionPage> {
  return {
    pages: pages.map((sessions) => ({ sessions, total: sessions.length })),
    pageParams: pages.map((_, i) => i),
  };
}

// ============================================================
describe("applySessionCreated", () => {
  it("filter=all → pages[0] 앞에 prepend하고 total을 +1 한다", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    const data = makeData([[s1]]);

    const result = applySessionCreated(data, s2, "all");

    expect(result.pages[0].sessions).toHaveLength(2);
    expect(result.pages[0].sessions[0].agentSessionId).toBe("s2");
    expect(result.pages[0].total).toBe(2);
  });

  it("filter 일치 → prepend한다", () => {
    const s1 = makeSession("s1", { sessionType: "task" });
    const s2 = makeSession("s2", { sessionType: "task" });
    const data = makeData([[s1]]);

    const result = applySessionCreated(data, s2, "task");

    expect(result.pages[0].sessions[0].agentSessionId).toBe("s2");
  });

  it("filter 불일치 → 데이터를 변경하지 않는다", () => {
    const s1 = makeSession("s1", { sessionType: "task" });
    const s2 = makeSession("s2", { sessionType: "llm" });
    const data = makeData([[s1]]);

    const result = applySessionCreated(data, s2, "task");

    expect(result.pages[0].sessions).toHaveLength(1);
    expect(result.pages[0].sessions[0].agentSessionId).toBe("s1");
    expect(result).toBe(data); // 동일 참조 반환
  });

  it("여러 페이지 → pages[0]에만 prepend한다", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    const s3 = makeSession("s3");
    const data = makeData([[s1], [s2]]);

    const result = applySessionCreated(data, s3, "all");

    expect(result.pages[0].sessions[0].agentSessionId).toBe("s3");
    expect(result.pages[1].sessions).toHaveLength(1);
    expect(result.pages[1].sessions[0].agentSessionId).toBe("s2");
  });
});

// ============================================================
describe("applySessionUpdated", () => {
  it("일치하는 세션을 업데이트한다", () => {
    const s1 = makeSession("s1", { status: "running" });
    const data = makeData([[s1]]);

    const result = applySessionUpdated(data, "s1", {
      status: "completed",
    } as Partial<SessionSummary>);

    expect(result.pages[0].sessions[0].status).toBe("completed");
  });

  it("여러 페이지에 걸쳐 올바른 세션만 업데이트한다", () => {
    const s1 = makeSession("s1", { status: "running" });
    const s2 = makeSession("s2", { status: "running" });
    const data = makeData([[s1], [s2]]);

    const result = applySessionUpdated(data, "s2", {
      status: "completed",
    } as Partial<SessionSummary>);

    expect(result.pages[0].sessions[0].status).toBe("running");
    expect(result.pages[1].sessions[0].status).toBe("completed");
  });

  it("미존재 ID → 데이터를 변경하지 않는다", () => {
    const s1 = makeSession("s1", { status: "running" });
    const data = makeData([[s1]]);

    const result = applySessionUpdated(data, "non-existent", {
      status: "completed",
    } as Partial<SessionSummary>);

    expect(result.pages[0].sessions[0].status).toBe("running");
  });
});

// ============================================================
describe("applySessionDeleted", () => {
  it("일치하는 세션을 제거한다", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    const data = makeData([[s1, s2]]);

    const result = applySessionDeleted(data, "s1");

    expect(result.pages[0].sessions).toHaveLength(1);
    expect(result.pages[0].sessions[0].agentSessionId).toBe("s2");
  });

  it("여러 페이지에서 일치하는 세션을 제거한다", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    const data = makeData([[s1], [s2]]);

    const result = applySessionDeleted(data, "s1");

    expect(result.pages[0].sessions).toHaveLength(0);
    expect(result.pages[1].sessions).toHaveLength(1);
  });

  it("미존재 ID → 데이터를 변경하지 않는다", () => {
    const s1 = makeSession("s1");
    const data = makeData([[s1]]);

    const result = applySessionDeleted(data, "non-existent");

    expect(result.pages[0].sessions).toHaveLength(1);
  });
});

// ============================================================
// F-10C 회귀 — buildSessionUpdates의 user 프로필 추출
//
// catalog API와 정합한 user 프로필을 SSE session_updated wire에서도 운반.
// 클라이언트가 추출하지 못하면 store의 userName/userPortraitUrl이 갱신되지 않아
// 새 세션 생성 직후 SSE만 받은 상태에서 폴백 표시되는 결함 잔존.

describe("buildSessionUpdates — F-10C user profile extraction", () => {
  function makeEvent(overrides: Partial<SessionUpdatedStreamEvent> = {}): SessionUpdatedStreamEvent {
    return {
      type: "session_updated",
      agent_session_id: "sess-1",
      status: "running",
      updated_at: new Date().toISOString(),
      ...overrides,
    } as SessionUpdatedStreamEvent;
  }

  it("event.userName/userPortraitUrl가 truthy면 updates에 추출한다", () => {
    const event = makeEvent({
      userName: "동료A",
      userPortraitUrl: "https://slack/img.png",
    });
    const updates = buildSessionUpdates(event);
    expect(updates.userName).toBe("동료A");
    expect(updates.userPortraitUrl).toBe("https://slack/img.png");
  });

  it("event.userName/userPortraitUrl가 null이면 머지하지 않는다 (기존 값 보존)", () => {
    const event = makeEvent({
      userName: null,
      userPortraitUrl: null,
    });
    const updates = buildSessionUpdates(event);
    // null이면 partial update 의미 보존 — 키 자체 추가 안 함
    expect(updates.userName).toBeUndefined();
    expect(updates.userPortraitUrl).toBeUndefined();
  });

  it("event.userName/userPortraitUrl가 undefined면 머지하지 않는다 (legacy wire 호환)", () => {
    // wire에 키가 없는 경우 (구버전 서버 호환)
    const event = makeEvent();
    const updates = buildSessionUpdates(event);
    expect(updates.userName).toBeUndefined();
    expect(updates.userPortraitUrl).toBeUndefined();
  });

  it("일부만 truthy → 그것만 추출한다", () => {
    const event = makeEvent({
      userName: "이름만",
      userPortraitUrl: null,
    });
    const updates = buildSessionUpdates(event);
    expect(updates.userName).toBe("이름만");
    expect(updates.userPortraitUrl).toBeUndefined();
  });
});
