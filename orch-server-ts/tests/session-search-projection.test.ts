import { describe, expect, it } from "vitest";

import { projectSessionSearchResults } from "../src/search/session_search_projection.js";

describe("product session search projection", () => {
  it("deduplicates by session before the result limit and keeps the strongest event anchor", () => {
    const results = projectSessionSearchResults([
      candidate("session-a", 9, "original", 4, "long-session later match"),
      candidate("session-a", 8, "original", 3, "long-session best match"),
      candidate("session-b", 3, "original", 2, "independent work"),
    ], "best match", 2);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.session_id)).toEqual(["session-a", "session-b"]);
    expect(results[0]?.best_match).toMatchObject({ event_id: 9, match_source: "message" });
    expect(results[0]?.session_url).toBe("/?session=session-a&event=9");
  });

  it("keeps title and digest matches eventless and carries only a linked task", () => {
    const [result] = projectSessionSearchResults([
      {
        session_id: "session-title",
        query_kind: "compact",
        id: null,
        match_source: "title",
        searchable_text: "피드 검색 자동 선택",
        display_name: "피드 검색 자동 선택",
        session_prompt: "",
        session_updated_at: "2026-09-22T00:00:00.000Z",
        caller_session_id: "caller-parent-session",
        predecessor_session_id: "predecessor-session",
        task_id: "task-a",
        task_title: "검색 개선",
        score: 2,
      },
      {
        session_id: "session-title",
        query_kind: "semantic",
        id: 999,
        match_source: "story",
        searchable_text: "피드 결과를 개선했다",
        display_name: "피드 검색 자동 선택",
        session_prompt: "",
        session_updated_at: "2026-09-22T00:00:00.000Z",
        caller_session_id: "caller-parent-session",
        predecessor_session_id: "predecessor-session",
        task_id: "task-a",
        task_title: "검색 개선",
        score: 0.8,
      },
    ], "피드검색", 10);

    expect(result).toMatchObject({
      session_id: "session-title",
      task_id: "task-a",
      parent_session_id: "caller-parent-session",
      best_match: { event_id: null, match_source: "title" },
      session_url: "/?session=session-title",
    });
  });

  it("keeps source score scales separate and ranks original evidence above repeated semantic re-quotes", () => {
    const results = projectSessionSearchResults([
      {
        ...candidate("actual-session", 11, "original", 0.000001, "실제 검색 요청의 답변"),
        session_updated_at: "2026-09-23T00:00:00.000Z",
        match_source: "message",
      },
      {
        ...candidate("title-scale-session", null, "original", 50, "제목 직접 일치"),
        session_updated_at: "2026-09-22T00:00:00.000Z",
        match_source: "title",
      },
      {
        ...candidate("diagnostic-session", 91, "semantic_1", 50, "피드 검색 결과 요약"),
        match_source: "title",
      },
      {
        ...candidate("diagnostic-session", 92, "semantic_2", 25, "피드 검색 결과를 설명"),
        match_source: "story",
      },
      {
        ...candidate("diagnostic-session", 93, "semantic_3", 10, "피드 검색 진단 기록"),
        match_source: "prompt",
      },
    ], "피드 검색", 10);

    expect(results.map((result) => result.session_id)).toEqual([
      "title-scale-session",
      "actual-session",
      "diagnostic-session",
    ]);
    expect(results[1]?.evidence).toHaveLength(1);
  });

  it("keeps an exact title match ahead of a higher-scale event score at a one-result limit", () => {
    const results = projectSessionSearchResults([
      {
        ...candidate("exact-title-session", null, "original", 2, "exact title"),
        match_source: "title",
        display_name: "검색 결과에서 연결 업무를 다시 여는 기능",
      },
      {
        ...candidate("high-bm25-event-session", 12, "original", 6, "검색 결과의 연결 업무를 논의"),
        match_source: "message",
        event_type: "user_message",
      },
    ], "검색 결과에서 연결 업무를 다시 여는 기능", 1);

    expect(results.map((result) => result.session_id)).toEqual(["exact-title-session"]);
    expect(results[0]?.best_match).toMatchObject({ event_id: null, match_source: "title" });
  });

  it("uses verified completion evidence to break a relevance tie with a diagnostic re-quotation", () => {
    const results = projectSessionSearchResults([
      {
        ...candidate("zz-actual-work-session", 21, "original", 1, "피드 검색 결과를 확인했다"),
        event_type: "assistant_message",
        task_evidence_kind: "task_item_completed",
        task_evidence_title: "피드 검색 결과 검증",
      },
      {
        ...candidate("aa-diagnostic-session", 31, "original", 1, "피드 검색 결과를 확인했다"),
        event_type: "user_message",
      },
    ], "피드 검색 결과를 확인했다", 10);

    expect(results.map((result) => result.session_id)).toEqual([
      "zz-actual-work-session",
      "aa-diagnostic-session",
    ]);
    expect(results[0]?.evidence).toContainEqual(expect.objectContaining({
      source: "task_item_completed",
      excerpt: "피드 검색 결과 검증",
    }));
    expect(results[1]?.evidence.some((item) => item.source.includes("task"))).toBe(false);
  });

  it("does not apply a blanket user-message relevance penalty", () => {
    const [result] = projectSessionSearchResults([
      {
        ...candidate("initial-request-session", 4, "original", 1, "피드 검색 자동 선택 개선을 찾아줘"),
        event_type: "user_message",
        relevance_source: "initial_request",
        session_updated_at: "2026-09-23T00:00:00.000Z",
      },
      {
        ...candidate("assistant-session", 5, "original", 1, "피드 검색 자동 선택 개선을 찾아줘"),
        event_type: "assistant_message",
        relevance_source: "assistant_message",
      },
    ], "피드검색", 10);

    expect(result?.session_id).toBe("initial-request-session");
  });

  it("ranks a strong semantic match above tied one-token initial-request noise", () => {
    const results = projectSessionSearchResults([
      {
        ...candidate("performed-session", 1, "semantic_2", 18.160247489075633, "기존 대화를 이어서 여는 기능을 구현했습니다."),
        relevance_source: "assistant_message",
        task_evidence_kind: "task_item_completed",
        task_evidence_title: "검색 결과 업무 재개 완료",
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        ...candidate(
          `unrelated-session-${index}`,
          index + 1,
          "semantic_2",
          0.0005502758629895976,
          `일반 개발 회의 ${index} 작업 일정 메모`,
        ),
        event_type: "user_message",
        relevance_source: "initial_request",
      })),
    ], "그때 하던 일을 계속 진행하고 싶어", 50);

    expect(results[0]?.session_id).toBe("performed-session");
    expect(results[0]?.evidence).toContainEqual(expect.objectContaining({
      source: "task_item_completed",
    }));
  });

  it("keeps the primary task for workspace resumption without turning it into work evidence", () => {
    const [result] = projectSessionSearchResults([
      {
        ...candidate("participant-session", 4, "original", 1, "Search task result was discussed"),
        task_id: "task-search",
        task_title: "Search task result",
      },
    ], "Search task result", 10);

    expect(result).toMatchObject({
      session_id: "participant-session",
      task_id: "task-search",
      task_title: "Search task result",
    });
    expect(result?.evidence.some((item) => [
      "task_item_completed",
      "task_completed",
      "source_task_item",
      "task_item_assigned",
    ].includes(item.source))).toBe(false);
  });

  it("exposes source task item evidence without treating it as verified completion", () => {
    const results = projectSessionSearchResults([
      candidate("aa-diagnostic-session", 3, "original", 1, "needle is discussed"),
      {
        ...candidate("zz-source-session", 4, "original", 1, "needle is discussed"),
        task_id: "task-search",
        task_title: "unrelated task title",
        task_evidence_kind: "source_task_item",
        task_evidence_title: "source item output",
      },
    ], "needle", 10);

    expect(results.map((result) => result.session_id)).toEqual([
      "aa-diagnostic-session",
      "zz-source-session",
    ]);
    expect(results[1]?.evidence).toContainEqual(expect.objectContaining({
      source: "source_task_item",
      excerpt: "source item output",
    }));
  });
});

function candidate(
  sessionId: string,
  eventId: number | null,
  queryKind: string,
  score: number,
  searchableText: string,
) {
  return {
    session_id: sessionId,
    query_kind: queryKind,
    id: eventId,
    event_type: "assistant_message",
    match_source: "message",
    searchable_text: searchableText,
    display_name: sessionId,
    session_prompt: "",
    session_updated_at: "2026-09-22T00:00:00.000Z",
    caller_session_id: null,
    predecessor_session_id: null,
    task_id: null,
    task_title: null,
    score,
  };
}
