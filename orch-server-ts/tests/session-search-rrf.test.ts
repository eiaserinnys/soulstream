import { describe, expect, it } from "vitest";

import {
  buildSessionSearchRrfPool,
  filterTitleResultsToIndexedSessions,
  orderSessionSearchResults,
  type SessionSearchPoolCandidate,
} from "../src/search/session_search_rrf.js";

describe("expanded session search RRF", () => {
  it("combines title and document ranks with reciprocal rank fusion", () => {
    const pool = buildSessionSearchRrfPool(
      [result("a", "2026-09-01"), result("b", "2026-09-02")],
      [result("b", "2026-09-02"), result("c", "2026-09-03")],
      (sessionId) => ({ title: sessionId }),
    );
    expect(pool.map((item) => item.session_id)).toEqual(["b", "a", "c"]);
    expect(pool[0]?.rrf_score).toBeCloseTo(2 / 61);
    expect(pool[1]?.rrf_score).toBeCloseTo(1 / 61);
  });

  it("uses updated_at to break RRF ties and Jev score then RRF order for output", () => {
    const pool = buildSessionSearchRrfPool(
      [result("old", "2026-09-01"), result("new", "2026-09-02")],
      [result("new", "2026-09-02"), result("old", "2026-09-01")],
      (sessionId) => ({ title: sessionId }),
    );
    const ordered = orderSessionSearchResults(pool, new Map([
      ["old", 0.7],
      ["new", 0.7],
    ]));
    expect(pool.map((item) => item.session_id)).toEqual(["new", "old"]);
    expect(ordered.map((item) => item.session_id)).toEqual(["new", "old"]);
    expect(ordered.every((item) => item.relevance === 0.7)).toBe(true);
  });

  it("keeps RRF order and null relevance after Jev failure", () => {
    const pool = buildSessionSearchRrfPool(
      [result("a", "2026-09-01"), result("b", "2026-09-02")],
      [result("b", "2026-09-02"), result("a", "2026-09-01")],
      (sessionId) => ({ title: sessionId }),
    );
    expect(orderSessionSearchResults(pool, null)).toMatchObject([
      { session_id: "b", relevance: null },
      { session_id: "a", relevance: null },
    ]);
  });

  it("omits A0-only LLM sessions from expanded results", () => {
    const titleResults = [
      result("ordinary", "2026-09-02"),
      result("internal-llm", "2026-09-03"),
    ];
    const indexedIds = new Set(["ordinary"]);
    const eligibleTitles = filterTitleResultsToIndexedSessions(
      titleResults,
      (sessionId) => indexedIds.has(sessionId),
    );
    const pool = buildSessionSearchRrfPool(
      eligibleTitles,
      [],
      (sessionId) => ({ title: sessionId }),
    );

    expect(orderSessionSearchResults(pool, null).map((item) => item.session_id)).toEqual(["ordinary"]);
  });
});

function result(session_id: string, updated_at: string): SessionSearchPoolCandidate["result"] {
  return {
    session_id,
    updated_at,
    title: session_id,
    excerpt: "excerpt",
    folder_id: null,
    node_id: null,
    status: null,
    backend: null,
    agent_name: null,
    review_required: false,
    task_id: null,
    task_title: null,
    parent_session_id: null,
    best_match: { event_id: null, match_source: "session_title", excerpt: "excerpt" },
    evidence: [],
    session_url: `/sessions/${session_id}`,
  };
}
