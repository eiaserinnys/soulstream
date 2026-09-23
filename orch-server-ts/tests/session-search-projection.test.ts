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
        predecessor_session_id: "parent-session",
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
        predecessor_session_id: "parent-session",
        task_id: "task-a",
        task_title: "검색 개선",
        score: 0.8,
      },
    ], "피드검색", 10);

    expect(result).toMatchObject({
      session_id: "session-title",
      task_id: "task-a",
      parent_session_id: "parent-session",
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
      "actual-session",
      "title-scale-session",
      "diagnostic-session",
    ]);
    expect(results[1]?.evidence).toHaveLength(1);
  });

  it("ranks semantic execution evidence above a literal user-message re-quotation", () => {
    const results = projectSessionSearchResults([
      {
        ...candidate("real-work-session", 21, "semantic_1", 0.00001, "수정 후 검색 결과를 확인했다"),
        event_type: "assistant_message",
      },
      {
        ...candidate("diagnostic-session", 31, "original", 100, "사용자가 피드 검색 문제를 다시 인용했다"),
        event_type: "user_message",
      },
    ], "피드 검색 결과가 이상해", 10);

    expect(results.map((result) => result.session_id)).toEqual([
      "real-work-session",
      "diagnostic-session",
    ]);
  });

  it("uses a matching linked task title as lexical evidence", () => {
    const [result] = projectSessionSearchResults([
      {
        ...candidate("task-linked-session", 4, "semantic_1", 0.8, "관련 대화"),
        task_id: "task-search",
        task_title: "피드 검색 자동 선택 개선",
      },
      {
        ...candidate("unrelated-session", 5, "semantic_1", 0.9, "다른 작업"),
        task_id: "task-other",
        task_title: "다른 검색 영역 개선",
      },
    ], "피드검색", 10);

    expect(result).toMatchObject({
      session_id: "task-linked-session",
      task_id: "task-search",
      task_title: "피드 검색 자동 선택 개선",
    });
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
    predecessor_session_id: null,
    task_id: null,
    task_title: null,
    score,
  };
}
