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
  shouldApplySessionCreatedToCache,
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
// F-A(2026-05-17) 이후: applySessionCreated는 cache 차원 적합성을 검사하지 않고
// prepend·dedup·page-0 분기만 책임. cache 적합성은 shouldApplySessionCreatedToCache
// predicate가 정본 가드 (design-principles §3).
describe("applySessionCreated", () => {
  it("pages[0] 앞에 prepend하고 total을 +1 한다", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    const data = makeData([[s1]]);

    const result = applySessionCreated(data, s2);

    expect(result.pages[0].sessions).toHaveLength(2);
    expect(result.pages[0].sessions[0].agentSessionId).toBe("s2");
    expect(result.pages[0].total).toBe(2);
  });

  it("이미 존재하는 세션은 중복 prepend하지 않는다 (낙관적 업데이트 dedup)", () => {
    const s1 = makeSession("s1");
    const data = makeData([[s1]]);

    const result = applySessionCreated(data, s1);

    expect(result).toBe(data); // 동일 참조 반환
  });

  it("여러 페이지 → pages[0]에만 prepend하고 다른 페이지는 보존", () => {
    const s1 = makeSession("s1");
    const s2 = makeSession("s2");
    const s3 = makeSession("s3");
    const data = makeData([[s1], [s2]]);

    const result = applySessionCreated(data, s3);

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

  // A3: session_updated 머지 시 backend 보존 검증.
  // SessionUpdatesPatch가 backend 키를 포함하지 않으므로 buildSessionUpdates는
  // wire에 backend가 와도 추출하지 않고, applySessionUpdated는 기존 backend를 보존.
  // G-19 contract: backend는 세션 생성 시점에 한 번 결정되며 lifecycle 동안 불변.
  it("session_updated 머지 시 기존 backend를 보존한다 (G-19 contract)", () => {
    const s1 = makeSession("s1", {
      status: "running",
      backend: "claude",
    });
    const data = makeData([[s1]]);

    const result = applySessionUpdated(data, "s1", {
      status: "completed",
      updatedAt: "2026-05-16T08:00:00Z",
    } as Partial<SessionSummary>);

    const merged = result.pages[0].sessions[0];
    expect(merged.backend).toBe("claude"); // 보존
    expect(merged.status).toBe("completed"); // 갱신
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

// ============================================================
// F-A(2026-05-17): SSE session_created 캐시 적용 predicate 검증.
// queryKey 구조 ["sessions", typeFilter, viewMode, folderId]별로 다음 invariant 검증:
//   - typeFilter "all"은 모든 sessionType 통과
//   - typeFilter !== "all" + 불일치 → 제외
//   - viewMode "feed" 캐시(folderId=null)는 어떤 폴더 세션이든 통과
//   - viewMode "folder" 캐시는 같은 folderId만 통과, 다른 폴더 / undefined → 제외
describe("shouldApplySessionCreatedToCache", () => {
  it("feed 캐시(typeFilter=all, viewMode=feed, folderId=null)는 모든 세션 통과", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "feed", null],
        "claude",
        "folder-X",
      ),
    ).toBe(true);
  });

  it("typeFilter='claude' 캐시는 sessionType=claude 통과", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "claude", "feed", null],
        "claude",
        undefined,
      ),
    ).toBe(true);
  });

  it("typeFilter='claude' 캐시는 sessionType=llm 제외", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "claude", "feed", null],
        "llm",
        undefined,
      ),
    ).toBe(false);
  });

  it("folder=folderA 캐시는 같은 folderId 세션 통과", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "folder", "folder-A"],
        "claude",
        "folder-A",
      ),
    ).toBe(true);
  });

  it("folder=folderA 캐시는 다른 folderB 세션 제외 (P0 핵심 — F-A 회귀 차단)", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "folder", "folder-A"],
        "claude",
        "folder-B",
      ),
    ).toBe(false);
  });

  it("folder 캐시는 folderId가 undefined인 세션(assignment 불명) 제외", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "folder", "folder-A"],
        "claude",
        undefined,
      ),
    ).toBe(false);
  });

  it("feed 캐시(folderId=null)는 assignment 불명 세션도 통과 (피드 표시 의도)", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "feed", null],
        "claude",
        undefined,
      ),
    ).toBe(true);
  });

  it("typeFilter + folder 둘 다 적용 — 둘 다 일치할 때만 통과", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "claude", "folder", "folder-A"],
        "claude",
        "folder-A",
      ),
    ).toBe(true);
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "claude", "folder", "folder-A"],
        "llm",
        "folder-A",
      ),
    ).toBe(false);
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "claude", "folder", "folder-A"],
        "claude",
        "folder-B",
      ),
    ).toBe(false);
  });
});
