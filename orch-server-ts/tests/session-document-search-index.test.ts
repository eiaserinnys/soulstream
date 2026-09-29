import { describe, expect, it } from "vitest";

import { LiveSessionDocumentSearch } from "../src/runtime/live_session_document_search.js";
import type { LiveSearchSql } from "../src/runtime/live_db_sql.js";
import {
  SessionDocumentSearchIndex,
  assembleSessionDocument,
  bigramTermFrequencies,
  chooseSessionSummary,
} from "../src/search/session_document_search_index.js";

describe("session document search index", () => {
  it("matches Python character bigrams and whitespace normalization", () => {
    expect([...bigramTermFrequencies("A 한글 😀")]).toEqual([
      ["A한", 1],
      ["한글", 1],
      ["글😀", 1],
    ]);
  });

  it("uses digest highlight before ordered turn summaries", () => {
    expect(chooseSessionSummary("digest", [
      { event_id: 9, content: "뒤" },
      { event_id: 3, content: "앞" },
    ])).toBe("digest");
    expect(chooseSessionSummary(null, [
      { event_id: 9, content: "뒤" },
      { event_id: 3, content: "앞" },
      { event_id: 10, content: "" },
    ])).toBe("앞 / 뒤");
    expect(chooseSessionSummary(null, [])).toBeNull();
  });

  it("cleans source fields, clips by Unicode character, and assembles C3", () => {
    const document = assembleSessionDocument({
      session_id: "session-1",
      display_name: "  ✨—제목",
      prompt: "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.   첫 요청\n두 번째",
      summary: "요약 😀".repeat(80),
      created_at: "2026-09-28T16:00:00.000Z",
      agent_id: "roselin",
    });

    expect(document.title).toBe("제목");
    expect(document.request).toBe("첫 요청 두 번째");
    expect(document.text.startsWith("제목 첫 요청 두 번째 ")).toBe(true);
    expect(Array.from(document.card.summary ?? "")).toHaveLength(300);
    expect(document.card.date).toBe("2026-09-29");
    expect(document.card.agent).toBe("roselin");
  });

  it("ranks with BM25 and applies incremental insert, update, rename, and delete", () => {
    const index = new SessionDocumentSearchIndex();
    index.initialize([
      record("a", "낡은 이름", "첫 요청", "처음 요약"),
      record("b", "삭제될 이름", "다른 내용", null),
    ]);

    expect(index.search("낡은 이름", 10).map((hit) => hit.session_id)[0]).toBe("a");

    index.applyRefresh(
      [
        record("a", "새 이름", "첫 요청", "갱신 요약"),
        record("c", "신규 세션", "새로운 요청", "새로운 요약"),
      ],
      [
        { session_id: "a", display_name: "새 이름" },
        { session_id: "c", display_name: "신규 세션" },
      ],
    );

    expect(index.search("갱신 요약", 10).map((hit) => hit.session_id)).toContain("a");
    expect(index.search("새로운 요청", 10).map((hit) => hit.session_id)).toContain("c");
    expect(index.get("a")?.title).toBe("새 이름");
    expect(index.get("b")).toBeUndefined();
  });

  it("breaks equal scores by candidate id", () => {
    const index = new SessionDocumentSearchIndex();
    index.initialize([
      record("z", "동일 문자열", "같은 문서", null),
      record("a", "동일 문자열", "같은 문서", null),
    ]);
    expect(index.search("없는 말", 2).map((hit) => hit.session_id)).toEqual(["a", "z"]);
  });

  it("uses the remaining search deadline for document refresh queries", async () => {
    const statementTimeouts: number[] = [];
    const sql = Object.assign(
      (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
      {
        setStatementTimeout: async (timeoutMs: number) => {
          statementTimeouts.push(timeoutMs);
        },
      },
    ) as unknown as LiveSearchSql;

    await new LiveSessionDocumentSearch().refresh({
      sql,
      activeQuery: {},
      deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal,
    });

    expect(statementTimeouts).toHaveLength(2);
    expect(statementTimeouts.every((timeoutMs) => timeoutMs > 3_000)).toBe(true);
  });
});

function record(
  session_id: string,
  display_name: string,
  prompt: string,
  summary: string | null,
) {
  return {
    session_id,
    display_name,
    prompt,
    summary,
    created_at: "2026-09-29T00:00:00.000Z",
    agent_id: "roselin",
  };
}
