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
      last_assistant_text: null,
      summary: "요약 😀".repeat(80),
      created_at: "2026-09-28T16:00:00.000Z",
      agent_id: "roselin",
    });

    expect(document.title).toBe("제목");
    expect(document.codePoints).toBeInstanceOf(Uint32Array);
    expect(Array.from(document.codePoints)).toEqual(
      Array.from("제목첫요청두번째" + "요약😀".repeat(80), (character) => character.codePointAt(0)!),
    );
    expect(document.bigramLength).toBe(document.codePoints.length - 1);
    expect(Object.keys(document).sort()).toEqual(["answerPreview", "bigramLength", "card", "codePoints", "title"]);
    expect("request" in document).toBe(false);
    expect("summary" in document).toBe(false);
    expect("text" in document).toBe(false);
    expect(Array.from(document.card.summary ?? "")).toHaveLength(300);
    expect(document.card.date).toBe("2026-09-29");
    expect(document.card.agent).toBe("roselin");
  });

  it("keeps the last assistant answer out of bigram text and the Jev card", () => {
    const answer = ` \u3000${"완료 😀  ".repeat(30)}끝 `;
    const withoutAnswer = assembleSessionDocument(record("a", "제목", "요청", null));
    const withAnswer = assembleSessionDocument(record("a", "제목", "요청", null, answer));

    expect(withAnswer.answerPreview).toBe(Array.from("완료 😀 ".repeat(30) + "끝", (character) => character).slice(0, 160).join(""));
    expect(withAnswer.codePoints).toEqual(withoutAnswer.codePoints);
    expect(withAnswer.card).toEqual(withoutAnswer.card);
  });

  it("ranks with BM25 and applies incremental insert, update, rename, and delete", () => {
    const index = new SessionDocumentSearchIndex();
    index.initialize([
      record("a", "낡은 이름", "첫 요청", "처음 요약"),
      record("b", "삭제될 이름", "다른 내용", null),
    ]);

    expect(index.search("낡은 이름", 10).map((hit) => hit.session_id)[0]).toBe("a");

    expect(index.findRosterChanges([
      { session_id: "a", display_name: "새 이름" },
      { session_id: "c", display_name: "신규 세션" },
    ])).toEqual({
      refreshSessionIds: ["a", "c"],
      deletedSessionIds: ["b"],
    });
    index.applyRefresh(
      [
        record("a", "새 이름", "첫 요청", "갱신 요약"),
        record("c", "신규 세션", "새로운 요청", "새로운 요약"),
      ],
      ["b"],
    );

    expect(index.search("갱신 요약", 10).map((hit) => hit.session_id)).toContain("a");
    expect(index.search("새로운 요청", 10).map((hit) => hit.session_id)).toContain("c");
    expect(index.get("a")?.title).toBe("새 이름");
    expect(index.get("b")).toBeUndefined();
  });

  it("returns stored document references instead of copying documents for top-k", () => {
    const index = new SessionDocumentSearchIndex();
    index.initialize([record("a", "제목", "요청", "요약")]);
    const stored = index.get("a");
    const hit = index.search("제목", 1)[0];

    expect(hit?.document).toBe(stored);
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

    expect(statementTimeouts).toHaveLength(3);
    expect(statementTimeouts.every((timeoutMs) => timeoutMs > 3_000)).toBe(true);
  });

  it("keeps the last assistant answer as a preview when cold sessions have no summary", async () => {
    const { sql, calls } = createRefreshSql((text) => {
      if (text.includes("FROM sessions") && text.includes("left(prompt")) {
        return [record("a", "제목", "요청", null, "완료 보고: PR #1045")];
      }
      if (text.includes("FROM session_digests")) return [];
      return [];
    });
    const search = new LiveSessionDocumentSearch();

    await search.refresh({
      sql,
      activeQuery: {},
      deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal,
    });

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("FROM sessions"),
      expect.stringContaining("FROM session_digests"),
      expect.stringContaining("FROM events"),
    ]));
    expect(calls.find((call) => call.text.includes("FROM sessions"))?.text)
      .toContain("left(last_assistant_text, 400)");
    expect(calls.every((call) => !/\bLATERAL\b|\bEXISTS\s*\(/i.test(call.text))).toBe(true);
    expect(search.index.get("a")?.card.summary).toBeUndefined();
    expect(search.index.get("a")?.answerPreview).toBe("완료 보고: PR #1045");
    expect(search.index.search("완료 보고", 10)[0]?.score).toBe(0);
  });

  it("keeps a digest highlight as summary and the last answer as a preview", async () => {
    const { sql } = createRefreshSql((text) => {
      if (text.includes("FROM sessions") && text.includes("left(prompt")) {
        return [record("a", "제목", "요청", null, "마지막 답변")];
      }
      if (text.includes("FROM session_digests")) {
        return [{ session_id: "a", highlight: "하이라이트 요약" }];
      }
      return [];
    });
    const search = new LiveSessionDocumentSearch();

    await search.refresh({
      sql,
      activeQuery: {},
      deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal,
    });

    expect(search.index.get("a")?.card.summary).toBe("하이라이트 요약");
    expect(search.index.get("a")?.answerPreview).toBe("마지막 답변");
  });

  it("refreshes only new, renamed, and timestamp-changed sessions", async () => {
    const { sql, calls } = createRefreshSql((text, values) => {
      const byArrayParameter = values.find(
        (value): value is readonly string[] => Array.isArray(value),
      );
      if (text.includes("UNION")) {
        const changed = [{ session_id: "b" }, { session_id: "d" }];
        if (/FROM sessions\s+WHERE[\s\S]*updated_at\s*>=/i.test(text)) {
          changed.push({ session_id: "e" });
        }
        return changed;
      }
      if (text.includes("FROM sessions") && text.includes("left(prompt") && text.includes("ANY(")) {
        return [
          record("a", "새 이름", "요청 A", "요약 A 갱신"),
          record("b", "제목 B", "요청 B", null),
          record("d", "신규 D", "요청 D", null),
          record("e", "제목 E", "요청 E", null, "최신 완료 보고"),
        ];
      }
      if (text.includes("FROM sessions") && text.includes("left(prompt")) {
        return [
          record("a", "이전 이름", "요청 A", null),
          record("b", "제목 B", "요청 B", null),
          record("c", "삭제 C", "요청 C", null),
          record("e", "제목 E", "요청 E", null, "이전 완료 보고"),
        ];
      }
      if (text.includes("SELECT session_id, display_name") && text.includes("FROM sessions")) {
        return [
          { session_id: "a", display_name: "새 이름" },
          { session_id: "b", display_name: "제목 B" },
          { session_id: "d", display_name: "신규 D" },
          { session_id: "e", display_name: "제목 E" },
        ];
      }
      if (text.includes("FROM session_digests")) {
        if (byArrayParameter?.includes("b")) {
          return [{ session_id: "b", highlight: "digest B 갱신" }];
        }
        return [];
      }
      if (text.includes("FROM events")) {
        if (byArrayParameter?.includes("a")) {
          return [{ session_id: "a", event_id: 9, content: "요약 A 갱신" }];
        }
        return [];
      }
      return [];
    });
    const search = new LiveSessionDocumentSearch();
    const input = {
      sql,
      activeQuery: {},
      deadlineAt: Date.now() + 10_000,
      signal: new AbortController().signal,
    };

    await search.refresh(input);
    await search.refresh(input);

    const changedIdQuery = calls.find((call) => call.text.includes("UNION"));
    expect(changedIdQuery?.text).toContain("created_at");
    expect(changedIdQuery?.text).toContain("updated_at");
    expect(changedIdQuery?.text).toMatch(/FROM sessions\s+WHERE[\s\S]*updated_at\s*>=/i);
    expect(changedIdQuery?.text).toMatch(/SELECT DISTINCT\s+session_id\s+FROM events/i);
    expect(changedIdQuery?.text).not.toMatch(/\bEXISTS\s*\(|\bLATERAL\b/i);

    const changedSessionQuery = calls.find((call) =>
      call.text.includes("FROM sessions") && call.text.includes("left(prompt") && call.text.includes("ANY("));
    expect(changedSessionQuery?.values).toContainEqual(["a", "b", "d", "e"]);
    expect(changedSessionQuery?.text).toContain("left(last_assistant_text, 400)");
    expect(search.index.get("a")?.title).toBe("새 이름");
    expect(search.index.get("b")?.card.summary).toBe("digest B 갱신");
    expect(search.index.get("c")).toBeUndefined();
    expect(search.index.get("d")?.card.request).toBe("요청 D");
    expect(search.index.get("e")?.card.summary).toBeUndefined();
    expect(search.index.get("e")?.answerPreview).toBe("최신 완료 보고");
  });
});

function record(
  session_id: string,
  display_name: string,
  prompt: string,
  summary: string | null,
  last_assistant_text: string | null = null,
) {
  return {
    session_id,
    display_name,
    prompt,
    last_assistant_text,
    summary,
    created_at: "2026-09-29T00:00:00.000Z",
    agent_id: "roselin",
  };
}

function createRefreshSql(
  respond: (text: string, values: unknown[]) => readonly Record<string, unknown>[],
) {
  const calls: { readonly text: string; readonly values: unknown[] }[] = [];
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return Object.assign(Promise.resolve(respond(text, values)), {
      cancel: () => undefined,
    });
  }, {
    setStatementTimeout: async (_timeoutMs: number) => undefined,
  }) as unknown as LiveSearchSql;
  return { sql, calls };
}
