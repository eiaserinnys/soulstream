/**
 * session-stream-helpers 테스트
 *
 * applySessionCreated/Updated/Deleted 순수 함수 검증.
 * node 환경에서 실행 (jsdom 불필요).
 */

import { describe, it, expect } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { CatalogState, SessionSummary } from "../shared/types";
import {
  applyCatalogDisplayNames,
  applySessionCreated,
  applySessionUpdated,
  applySessionDeleted,
  buildSessionUpdates,
  countLoadedSessionsForQuery,
  filterFeedSessions,
  mergeSessionAssignmentsFromSummaries,
  mergeSessionCreatedSummary,
  normalizeSessionStatus,
  preserveCatalogSessionList,
  reconcileSessionPagesForCatalog,
  removeSessionFromCatalogSessionList,
  shouldApplySessionCreatedToCache,
  updateSessionInCatalogSessionList,
  upsertSessionAssignmentInCatalog,
  upsertSessionInCatalogSessionList,
} from "./session-stream-helpers";
import { normalizeSessionStatus as normalizeSharedSessionStatus } from "../shared/session-status";
import type { SessionPage } from "./session-stream-helpers";
import type { SessionUpdatedStreamEvent } from "../shared/stream-events";
import { toSessionSummary } from "../shared/mappers";

function makeSession(
  id: string,
  overrides?: Partial<SessionSummary>,
): SessionSummary {
  return {
    agentSessionId: id,
    // sessionType 정의는 `"claude" | "llm"` (session-types.ts). 직전 fixture의 "task"는 type
   // 불일치 — 사이클 A에서 정정.
    sessionType: "claude",
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

function makeCatalog(sessionList: SessionSummary[] = []): CatalogState {
  return {
    folders: [],
    sessions: {},
    boardItems: [],
    sessionList,
  };
}

describe("catalog sessionList helpers", () => {
  it("upserts session_created into catalog.sessionList while preserving assignment", () => {
    const created = makeSession("child", { callerSessionId: "parent", prompt: "created" });
    const result = upsertSessionAssignmentInCatalog(makeCatalog(), "child", "folder-a", created);

    expect(result.sessions.child).toEqual({ folderId: "folder-a", displayName: null });
    expect(result.sessionList?.map((session) => session.agentSessionId)).toEqual(["child"]);
    expect(result.sessionList?.[0].callerSessionId).toBe("parent");
  });

  it("updates and removes entries from catalog.sessionList", () => {
    const catalog = makeCatalog([makeSession("s1", { status: "running" })]);
    const updated = updateSessionInCatalogSessionList(catalog, "s1", { status: "completed" });
    expect(updated.sessionList?.[0].status).toBe("completed");

    const removed = removeSessionFromCatalogSessionList(updated, "s1");
    expect(removed.sessionList).toEqual([]);
  });

  it("upserts sessionList even when session_created carries no folder assignment", () => {
    const result = upsertSessionInCatalogSessionList(
      makeCatalog(),
      makeSession("floating-child", { callerSessionId: "parent" }),
    );

    expect(result.sessions).toEqual({});
    expect(result.sessionList?.[0].agentSessionId).toBe("floating-child");
    expect(result.sessionList?.[0].callerSessionId).toBe("parent");
  });

  it("preserves sessionList when catalog_updated carries catalog-only data", () => {
    const current = makeCatalog([makeSession("s1", { callerSessionId: "parent" })]);
    const incoming: CatalogState = {
      folders: [],
      sessions: { s1: { folderId: "root", displayName: null } },
      boardItems: [],
    };

    const result = preserveCatalogSessionList(incoming, current);

    expect(result.sessionList?.[0].agentSessionId).toBe("s1");
    expect(result.sessions.s1.folderId).toBe("root");
  });

  it("stores /api/sessions summaries in catalog.sessionList while merging assignments", () => {
    const summary = makeSession("folder-session", {
      folderId: "folder-a",
      displayName: "Pinned title",
      agentName: "Roselin",
      agentPortraitUrl: "/api/nodes/eias/agents/roselin_codex/portrait",
      backend: "codex",
    });

    const result = mergeSessionAssignmentsFromSummaries(makeCatalog(), [summary]);

    expect(result.sessions["folder-session"]).toEqual({
      folderId: "folder-a",
      displayName: "Pinned title",
    });
    expect(result.sessionList?.[0]).toMatchObject({
      agentSessionId: "folder-session",
      agentName: "Roselin",
      agentPortraitUrl: "/api/nodes/eias/agents/roselin_codex/portrait",
      backend: "codex",
    });
  });
});

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

  it("이미 존재하는 세션은 prepend하지 않고 *merge*만 한다 (낙관적 업데이트 dedup + 사이클 A merge)", () => {
    // 사이클 A 정정 (분석 캐시 `20260518-1405-cycle-a-optimistic-session-merge.md`):
    // 직전 동작은 `if (exists) return data` 동일 reference 반환 — 서버 정본을 silent skip.
    // 본 fix는 *exists 분기에서도 mergeSessionCreatedSummary*를 적용하여 정의된 incoming
    // 필드를 덮어쓴다. 동일 reference는 더 이상 보장되지 않지만 prepend는 안 함 + total 유지.
    const s1 = makeSession("s1");
    const data = makeData([[s1]]);

    const result = applySessionCreated(data, s1);

    // prepend 안 함 — sessions length·total 유지
    expect(result.pages[0].sessions).toHaveLength(1);
    expect(result.pages[0].sessions[0].agentSessionId).toBe("s1");
    expect(result.pages[0].total).toBe(1);
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

  // 사이클 A — 낙관적 세션 ↔ 서버 정본 race (외부 codex 진단 ②)
  // 분석 캐시 `20260518-1405-cycle-a-optimistic-session-merge.md`.
  it("낙관적 세션이 이미 있으면 session_created 서버 필드를 병합하고 total은 유지", () => {
    const optimistic = makeSession("s1", {
      prompt: "hello",
      userName: undefined,
      userPortraitUrl: undefined,
    } as Partial<SessionSummary>);
    const created = makeSession("s1", {
      status: "running",
      userName: "Jubok Kim",
      userPortraitUrl: "https://example.com/avatar.png",
      lastEventId: 7,
    } as Partial<SessionSummary>);
    const data = makeData([[optimistic]]);

    const result = applySessionCreated(data, created);

    expect(result.pages[0].sessions).toHaveLength(1);
    expect(result.pages[0].total).toBe(1);
    const merged = result.pages[0].sessions[0] as unknown as Record<string, unknown>;
    expect(merged.prompt).toBe("hello");
    expect(merged.userName).toBe("Jubok Kim");
    expect(merged.userPortraitUrl).toBe("https://example.com/avatar.png");
    expect(merged.lastEventId).toBe(7);
  });

  it("낙관적 세션 병합 — incoming undefined는 기존 값 보존, null은 덮어쓴다", () => {
    const optimistic = makeSession("s1", {
      userName: "기존 이름",
      userPortraitUrl: "/old.png",
      agentPortraitUrl: "/agent.png",
    } as Partial<SessionSummary>);
    const created = makeSession("s1", {
      userName: undefined,        // skip (기존 보존)
      userPortraitUrl: null,      // null은 살림 (덮어씀)
      agentPortraitUrl: "/new.png",
    } as unknown as Partial<SessionSummary>);
    const data = makeData([[optimistic]]);

    const result = applySessionCreated(data, created);

    const merged = result.pages[0].sessions[0] as unknown as Record<string, unknown>;
    expect(merged.userName).toBe("기존 이름");  // undefined → skip
    expect(merged.userPortraitUrl).toBeNull();   // null → 덮어씀
    expect(merged.agentPortraitUrl).toBe("/new.png");
  });
});

// ============================================================
describe("mergeSessionCreatedSummary", () => {
  it("undefined incoming 필드는 기존 값 보존", () => {
    const current = makeSession("s1", {
      prompt: "hello",
      userName: "alice",
    } as Partial<SessionSummary>);
    const incoming = makeSession("s1", {
      prompt: undefined,
      userName: undefined,
    } as Partial<SessionSummary>);
    const result = mergeSessionCreatedSummary(current, incoming);
    expect(result.prompt).toBe("hello");
    expect(result.userName).toBe("alice");
  });

  it("null incoming은 살아남아 덮어쓴다 (null = 유효 unset)", () => {
    const current = makeSession("s1", {
      userPortraitUrl: "/old.png",
    } as Partial<SessionSummary>);
    const incoming = makeSession("s1", {
      userPortraitUrl: null,
    } as unknown as Partial<SessionSummary>);
    const result = mergeSessionCreatedSummary(current, incoming);
    expect(result.userPortraitUrl).toBeNull();
  });

  it("정의된 incoming 필드만 덮어쓴다 (혼합 케이스)", () => {
    const current = makeSession("s1", {
      prompt: "hello",
      userName: undefined,
      agentPortraitUrl: "/agent.png",
    } as Partial<SessionSummary>);
    const incoming = makeSession("s1", {
      prompt: undefined,
      userName: "Jubok Kim",
      agentPortraitUrl: undefined,
    } as Partial<SessionSummary>);
    const result = mergeSessionCreatedSummary(current, incoming);
    expect(result.prompt).toBe("hello");
    expect(result.userName).toBe("Jubok Kim");
    expect(result.agentPortraitUrl).toBe("/agent.png");
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

  it("review snake_case와 camelCase를 같은 cache patch로 정규화한다", () => {
    expect(buildSessionUpdates(makeEvent({
      review_required: true,
      review_state: "needs_review",
    }))).toMatchObject({
      reviewRequired: true,
      reviewState: "needs_review",
    });
    expect(buildSessionUpdates(makeEvent({
      reviewRequired: true,
      reviewState: "acknowledged",
    }))).toMatchObject({
      reviewRequired: true,
      reviewState: "acknowledged",
    });
  });
});

describe("normalizeSessionStatus", () => {
  it("known SessionStatus 값은 보존한다", () => {
    expect(normalizeSessionStatus("running")).toBe("running");
    expect(normalizeSessionStatus("completed")).toBe("completed");
    expect(normalizeSessionStatus("error")).toBe("error");
    expect(normalizeSessionStatus("interrupted")).toBe("interrupted");
  });

  it("turn phase idle은 카드 상태에서 running으로 접는다", () => {
    expect(normalizeSessionStatus("idle")).toBe("running");
    const event = {
      type: "session_updated",
      agent_session_id: "sess-1",
      status: "idle",
      updated_at: new Date().toISOString(),
    } as unknown as SessionUpdatedStreamEvent;
    expect(buildSessionUpdates(event).status).toBe("running");
  });

  it("알 수 없는 값은 unknown으로 정규화한다", () => {
    expect(normalizeSessionStatus("paused")).toBe("unknown");
    expect(normalizeSessionStatus(null)).toBe("unknown");
  });
});

describe("applyCatalogDisplayNames", () => {
  it("catalog assignment이 없어도 provider가 넘긴 세션을 탈락시키지 않는다", () => {
    const sessions = [makeSession("s1", { prompt: "hello" })];
    const result = applyCatalogDisplayNames(sessions, {
      folders: [{ id: "folder-1", name: "Folder", sortOrder: 0 }],
      sessions: {},
    });

    expect(result).toHaveLength(1);
    expect(result[0].agentSessionId).toBe("s1");
  });

  it("displayName override만 적용한다", () => {
    const sessions = [makeSession("s1", { prompt: "hello" })];
    const result = applyCatalogDisplayNames(sessions, {
      folders: [{ id: "folder-1", name: "Folder", sortOrder: 0 }],
      sessions: { s1: { folderId: "folder-1", displayName: "Pinned" } },
    });

    expect(result[0].displayName).toBe("Pinned");
  });
});

describe("reconcileSessionPagesForCatalog", () => {
  it("folder cache에서 다른 폴더로 이동한 세션을 즉시 제거한다", () => {
    const result = reconcileSessionPagesForCatalog(
      makeData([[makeSession("s-a"), makeSession("s-b")]]),
      ["sessions", "all", "folder", "folder-A"],
      {
        folders: [
          { id: "folder-A", name: "A", sortOrder: 0 },
          { id: "folder-B", name: "B", sortOrder: 1 },
        ],
        sessions: {
          "s-a": { folderId: "folder-A", displayName: null },
          "s-b": { folderId: "folder-B", displayName: null },
        },
      },
    );

    expect(result.pages[0].sessions.map((s) => s.agentSessionId)).toEqual([
      "s-a",
    ]);
  });

  it("feed cache에서 excludeFromFeed 폴더와 llm 세션을 즉시 제거한다", () => {
    const result = reconcileSessionPagesForCatalog(
      makeData([
        [
          makeSession("visible"),
          makeSession("hidden"),
          makeSession("llm", { sessionType: "llm" }),
        ],
      ]),
      ["sessions", "all", "feed", null],
      {
        folders: [
          { id: "visible-folder", name: "Visible", sortOrder: 0 },
          {
            id: "hidden-folder",
            name: "Hidden",
            sortOrder: 1,
            settings: { excludeFromFeed: true },
          },
        ],
        sessions: {
          visible: { folderId: "visible-folder", displayName: null },
          hidden: { folderId: "hidden-folder", displayName: null },
          llm: { folderId: null, displayName: null },
        },
      },
    );

    expect(result.pages[0].sessions.map((s) => s.agentSessionId)).toEqual([
      "visible",
    ]);
  });
});

describe("filterFeedSessions", () => {
  it("24시간 윈도를 적용하지 않고 오래된 세션도 포함한다", () => {
    const result = filterFeedSessions(
      [
        makeSession("new", { updatedAt: "2026-05-23T00:00:00Z" }),
        makeSession("old", { updatedAt: "2026-05-01T00:00:00Z" }),
      ],
      { folders: [], sessions: {} },
    );

    expect(result.map((s) => s.agentSessionId)).toEqual(["new", "old"]);
  });
});

describe("shared normalizeSessionStatus", () => {
  it("공통 mapper와 stream helper가 같은 정규화 함수를 쓴다", () => {
    expect(normalizeSharedSessionStatus("idle")).toBe("running");
  });

  it("초기 목록/created mapper도 idle을 running으로 정규화한다", () => {
    expect(toSessionSummary({
      agent_session_id: "s1",
      status: "idle",
      created_at: "2026-01-01T00:00:00Z",
    }).status).toBe("running");
  });
});

// ============================================================
// F-A(2026-05-17): SSE session_created 캐시 적용 predicate 검증.
// queryKey 구조 ["sessions", typeFilter, viewMode, folderId]별로 다음 invariant 검증:
//   - typeFilter "all"은 모든 sessionType 통과
//   - typeFilter !== "all" + 불일치 → 제외
//   - viewMode "feed" 캐시(folderId=null)는 feed-eligible 폴더 세션만 통과
//   - viewMode "folder" 캐시는 같은 folderId만 통과, 다른 폴더 / undefined → 제외
describe("shouldApplySessionCreatedToCache", () => {
  it("ids 캐시는 참조된 session_created만 통과시킨다", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "ids", null, ["session-a"]],
        "claude",
        null,
        null,
        "session-a",
      ),
    ).toBe(true);
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "ids", null, ["session-a"]],
        "claude",
        null,
        null,
        "session-b",
      ),
    ).toBe(false);
  });

  it("feed 캐시(typeFilter=all, viewMode=feed, folderId=null)는 모든 세션 통과", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "feed", null],
        "claude",
        "folder-X",
      ),
    ).toBe(true);
  });

  it("feed 캐시는 catalog상 excludeFromFeed 폴더의 session_created를 제외한다", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "feed", null],
        "claude",
        "hidden-folder",
        {
          folders: [
            {
              id: "hidden-folder",
              name: "Hidden",
              sortOrder: 0,
              settings: { excludeFromFeed: true },
            },
          ],
          sessions: {},
        },
      ),
    ).toBe(false);
  });

  it("feed 캐시는 catalog상 일반 폴더의 session_created를 통과시킨다", () => {
    expect(
      shouldApplySessionCreatedToCache(
        ["sessions", "all", "feed", null],
        "claude",
        "visible-folder",
        {
          folders: [
            {
              id: "visible-folder",
              name: "Visible",
              sortOrder: 0,
              settings: { excludeFromFeed: false },
            },
          ],
          sessions: {},
        },
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

describe("countLoadedSessionsForQuery", () => {
  it("feed pagination offset ignores sessions that do not belong to the feed query", () => {
    const pages = [
      {
        sessions: [
          makeSession("visible", { updatedAt: "2026-05-23T00:00:00Z" }),
          makeSession("hidden", { updatedAt: "2026-05-23T00:01:00Z" }),
          makeSession("llm", {
            sessionType: "llm",
            updatedAt: "2026-05-23T00:02:00Z",
          }),
        ],
        total: 3,
      },
    ];

    expect(
      countLoadedSessionsForQuery(
        pages,
        ["sessions", "all", "feed", null],
        {
          folders: [
            {
              id: "visible-folder",
              name: "Visible",
              sortOrder: 0,
            },
            {
              id: "hidden-folder",
              name: "Hidden",
              sortOrder: 1,
              settings: { excludeFromFeed: true },
            },
          ],
          sessions: {
            visible: { folderId: "visible-folder", displayName: null },
            hidden: { folderId: "hidden-folder", displayName: null },
            llm: { folderId: null, displayName: null },
          },
        },
      ),
    ).toBe(1);
  });

  it("deduplicates sessions before computing the next pagination offset", () => {
    const visible = makeSession("visible", { updatedAt: "2026-05-23T00:00:00Z" });
    const pages = [
      { sessions: [visible], total: 2 },
      { sessions: [visible, makeSession("next")], total: 2 },
    ];

    expect(
      countLoadedSessionsForQuery(
        pages,
        ["sessions", "all", "feed", null],
        { folders: [], sessions: {} },
      ),
    ).toBe(2);
  });
});
