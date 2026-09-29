import { describe, expect, it, vi } from "vitest";

import {
  createLiveCogitoSearchProvider,
  type LiveSearchSql,
} from "../src/index.js";

type SqlCall = { text: string; values: unknown[] };

describe("live Cogito search provider", () => {
  it("reports document-index and projection timing without changing the public payload", async () => {
    const harness = createSqlHarness(() => []);
    const observations: Array<Record<string, unknown>> = [];
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
      onSearchTiming: (timing: Record<string, unknown>) => observations.push(timing),
    } as never);

    const response = await provider.search({
      q: "의역 질의",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "expanded",
    });

    expect(response).not.toHaveProperty("timing");
    expect(response.search_status?.query_expansion).toEqual({ status: "skipped", latency_ms: 0 });
    expect(response.search_status?.session_sources).toMatchObject({
      session_document: { status: "complete" },
      rerank: { status: "partial", reason: "error" },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(expect.objectContaining({
      lexicalSqlMs: expect.any(Number),
      documentIndexBuildMs: expect.any(Number),
      semanticSqlMs: expect.any(Number),
      projectionMs: expect.any(Number),
      totalMs: expect.any(Number),
    }));
  });

  it("keeps A0 title results when document hydration reaches the search deadline", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("WITH requested AS")) {
        throw Object.assign(new Error("statement timeout"), { code: "57014" });
      }
      if (text.includes("'session_metadata'::text AS event_type")) {
        return [{
          id: null,
          session_id: "session-a",
          event_type: "session_metadata",
          searchable_text: "cold title",
          created_at: "2026-09-23T00:00:00.000Z",
          score: 2,
          match_source: "title",
          display_name: "cold title",
          session_prompt: "",
          folder_id: "folder-a",
          predecessor_session_id: null,
          session_updated_at: "2026-09-23T00:00:00.000Z",
          task_id: null,
          task_title: null,
        }];
      }
      if (text.includes("SELECT session_id, display_name")) {
        return [{ session_id: "session-a", display_name: "cold title" }];
      }
      if (text.includes("left(session.prompt, 2000)")) {
        return [{
          session_id: "session-a",
          display_name: "cold title",
          prompt: "",
          created_at: "2026-09-23T00:00:00.000Z",
          agent_id: "agent-a",
          summary: null,
        }];
      }
      return [];
    });
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    const response = await provider.search({
      q: "cold title",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "expanded",
    });

    expect(response.session_results).toMatchObject([{
      session_id: "session-a",
      title: "cold title",
      relevance: null,
      best_match: { match_source: "title" },
    }]);
    expect(response.search_status?.search).toEqual({
      status: "partial",
      stage: "semantic",
      reason: "timeout",
    });
  });

  it("queries shared PostgreSQL once, deduplicates event/session matches, and returns navigation", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("event_search")) {
        return [{
          id: 7,
          session_id: "sess-a",
          event_type: "assistant_message",
          searchable_text: "matching answer",
          score: 0.9,
        }];
      }
      if (text.includes("session_id_search")) {
        return [{
          id: 7,
          session_id: "sess-a",
          event_type: "assistant_message",
          searchable_text: "matching answer",
          score: 0.5,
        }];
      }
      if (text.includes("FROM folders")) {
        return [
          {
            kind: "folder",
            id: "folder-a",
            title: "Matching project",
            folder_id: "folder-a",
            project_page_id: "project-page-a",
            board_item_id: null,
            task_page_id: null,
          },
          {
            kind: "task",
            id: "task-a",
            title: "Matching task",
            folder_id: "folder-a",
            project_page_id: "project-page-a",
            board_item_id: "board-item-a",
            task_page_id: "task-page-a",
          },
        ];
      }
      return [];
    });
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    await expect(provider.search({
      q: "matching",
      top_k: 20,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
    })).resolves.toEqual({
      results: [{
        session_id: "sess-a",
        folder_id: null,
        event_id: 7,
        event_type: "assistant_message",
        preview: "matching answer",
        score: 0.9,
        match_source: "message",
      }],
      navigation_results: [
        {
          kind: "folder",
          id: "folder-a",
          title: "Matching project",
          folder_id: "folder-a",
          project_page_id: "project-page-a",
        },
        {
          kind: "task",
          id: "task-a",
          title: "Matching task",
          folder_id: "folder-a",
          project_page_id: "project-page-a",
          board_item_id: "board-item-a",
          task_page_id: "task-page-a",
        },
      ],
    });
    expect(harness.calls.filter((call) => call.text.includes("event_search"))).toHaveLength(1);
    expect(harness.calls.filter((call) => call.text.includes("session_id_search"))).toHaveLength(1);
    expect(harness.calls[0]?.values[3]).toEqual([
      "user_message",
      "intervention_sent",
      "assistant_message",
      "result",
      "complete",
    ]);
  });

  it("keeps eventless session metadata matches out of event results", async () => {
    const harness = createSqlHarness((text) => {
      if (!text.includes("'session_metadata'::text AS event_type")) return [];
      return [{
        id: null,
        session_id: "session-title",
        event_type: "session_metadata",
        searchable_text: "Exact session title",
        created_at: "2026-09-23T00:00:00.000Z",
        score: 2,
        match_source: "title",
        display_name: "Exact session title",
        session_prompt: "",
        folder_id: "folder-a",
        predecessor_session_id: null,
        session_updated_at: "2026-09-23T00:00:00.000Z",
        task_id: null,
        task_title: null,
      }];
    });
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    const response = await provider.search({
      q: "exact",
      top_k: 1,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "lexical",
    });

    expect(response.results).toEqual([]);
    expect(response.session_results).toMatchObject([{
      session_id: "session-title",
      best_match: { event_id: null, match_source: "title" },
      session_url: "/?session=session-title",
    }]);
  });

  it("returns the lexical session projection without starting query expansion", async () => {
    const harness = createSqlHarness((text) => text.includes("'session_metadata'::text AS event_type")
      ? [{
        id: null,
        session_id: "lexical-session",
        event_type: "session_metadata",
        searchable_text: "검색 제목",
        created_at: "2026-09-23T00:00:00.000Z",
        score: 2,
        match_source: "title",
        display_name: "검색 제목",
        session_prompt: "",
        folder_id: "folder-a",
        predecessor_session_id: null,
        session_updated_at: "2026-09-23T00:00:00.000Z",
        task_id: null,
        task_title: null,
      }]
      : []);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    const response = await provider.search({
      q: "검색 제목",
      top_k: 20,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
    });

    expect(response.session_results?.map((row) => row.session_id)).toEqual(["lexical-session"]);
    expect(response.search_status?.query_expansion).toEqual({ status: "skipped", latency_ms: 0 });
    expect(harness.calls.filter((call) => call.text.includes("event_search(")).length).toBe(0);
    expect(response.search_status?.session_sources).toEqual({
      metadata: { status: "complete" },
      metadata_prompt_tokens: { status: "deferred" },
      original_body: { status: "deferred" },
      semantic_body: { status: "deferred" },
    });
    expect(harness.calls.filter((call) => call.text.includes("session_metadata"))).toHaveLength(3);
    expect(harness.calls.some((call) => call.text.includes("session_search_tokens(candidate.prompt)")))
      .toBe(false);
    const metadataCall = harness.calls.find((call) => call.text.includes("session_metadata"));
    expect(metadataCall?.text).toContain("UNION ALL");
    expect(metadataCall?.text).toContain("session_search_index_prefix(candidate.display_name_search_key)");
    expect(metadataCall?.text).toContain("candidate.display_name_search_key LIKE");
    expect(metadataCall?.text).toContain("candidate.folder_id = ANY");
    expect(metadataCall?.text).toContain("bounded_metadata AS MATERIALIZED");
    expect(metadataCall?.text.indexOf("bounded_metadata AS MATERIALIZED"))
      .toBeLessThan(metadataCall?.text.indexOf("LEFT JOIN LATERAL (") ?? -1);
  });

  it("returns no metadata candidates for punctuation-only variants without issuing invalid SQL", async () => {
    const harness = createSqlHarness(() => []);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    const response = await provider.search({
      q: "!!!",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
    });

    expect(response.session_results).toEqual([]);
    expect(response.search_status?.session_sources?.metadata).toEqual({ status: "complete" });
    expect(harness.calls.some((call) => call.text.includes("session_metadata"))).toBe(false);
  });

  it("uses indexed token candidates for particle and word-order variants", async () => {
    const harness = createSqlHarness(() => []);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    await provider.search({
      q: "업무 자동 선택 수정 검색 세션",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["folder-allowed"],
    });

    const metadataCalls = harness.calls.filter((call) => call.text.includes("session_metadata"));
    const titleTokenCall = metadataCalls.find((call) => call.text.includes("session_search_tokens(candidate.display_name)"));
    const promptPrefixCall = metadataCalls.find((call) => call.text.includes("session_search_index_prefix(candidate.prompt_search_key)"));
    const promptTokenCall = metadataCalls.find((call) => call.text.includes("session_search_tokens(candidate.prompt)"));
    expect(metadataCalls).toHaveLength(3);
    expect(titleTokenCall?.text).toContain("&&");
    expect(titleTokenCall?.text).toContain("candidate.folder_id = ANY");
    expect(titleTokenCall?.text).toContain("bounded_metadata AS MATERIALIZED");
    expect(promptPrefixCall?.text).toContain("session_search_index_prefix(candidate.prompt_search_key)");
    expect(promptTokenCall).toBeUndefined();
  });

  it("keeps long original queries on the exact/prefix path in lexical search", async () => {
    const harness = createSqlHarness(() => []);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    const longQuery = "세션 검색 ".repeat(30);
    const params = {
      q: longQuery,
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "messages,responses",
      include_session_results: true,
      allowedFolderIds: ["folder-allowed"],
    };
    await provider.search({ ...params, session_search_mode: "lexical" });

    const metadataCalls = harness.calls.filter((call) => call.text.includes("session_metadata"));
    expect(metadataCalls).toHaveLength(2);
    expect(metadataCalls.every((call) => !call.text.includes("session_search_tokens("))).toBe(true);
  });

  it("does not query session ids when the option is disabled and keeps tools opt-in", async () => {
    const harness = createSqlHarness(() => []);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    await provider.search({
      q: "trace",
      top_k: 5,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      event_categories: "thinking,tools",
    });

    expect(harness.calls[0]?.values).toContain(false);
    expect(harness.calls[0]?.values[3]).toEqual([
      "thinking",
      "tool_start",
      "tool_result",
    ]);
  });

  it("applies allowed folders inside lexical metadata and navigation candidates", async () => {
    const harness = createSqlHarness(() => []);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
    });

    await provider.search({
      q: "피드 검색",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: true,
      include_story: true,
      include_session_results: true,
      session_search_mode: "lexical",
      allowedFolderIds: ["visible-root", "visible-child"],
    });

    expect(harness.calls).toHaveLength(4);
    const metadataCalls = harness.calls.filter((call) => call.text.includes("session_metadata"));
    const navigationCall = harness.calls.find((call) => call.text.includes("FROM folders"));
    expect(metadataCalls).toHaveLength(3);
    for (const metadataCall of metadataCalls) {
      expect(metadataCall.text).toContain("candidate.folder_id = ANY");
      expect(metadataCall.text).toContain("primary_session_item.container_kind = 'task'");
      expect(metadataCall.text).toContain("primary_session_item.membership_kind = 'primary'");
      expect(metadataCall.values).toContainEqual(["visible-root", "visible-child"]);
    }
    expect(navigationCall?.text).toContain("f.id = ANY");
    expect(navigationCall?.values).toContainEqual(["visible-root", "visible-child"]);
  });

  it("cancels the active query and dispatches no later query after abort", async () => {
    const controller = new AbortController();
    let announceDispatch!: () => void;
    let rejectActive!: (error: Error) => void;
    const dispatched = new Promise<void>((resolve) => { announceDispatch = resolve; });
    const cancel = vi.fn(() => rejectActive(new Error("cancelled")));
    const calls: string[] = [];
    const close = vi.fn(async () => undefined);
    const pendingQuery = (text: string) => {
      calls.push(text);
      announceDispatch();
      const pending = new Promise<readonly Record<string, unknown>[]>((_resolve, reject) => {
        rejectActive = reject;
      });
      return Object.assign(pending, { cancel, canceller: () => Promise.resolve(cancel()) });
    };
    const sql = Object.assign(
      (strings: TemplateStringsArray) => pendingQuery(strings.join("?")),
      { unsafe: (text: string) => pendingQuery(text) },
    ) as unknown as LiveSearchSql;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: {
        open: async () => ({ sql, close }),
      },
    });
    const search = provider.search({
      q: "검색어",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
      signal: controller.signal,
    });

    await dispatched;
    controller.abort();

    await expect(search).resolves.toMatchObject({
      results: [],
      navigation_results: [],
      session_results: [],
      search_status: {
        query_expansion: { status: "skipped", latency_ms: 0 },
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns explicit partial status when PostgreSQL reaches the query-local timeout", async () => {
    const timeoutError = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const sql = Object.assign((() => Object.assign(
      Promise.resolve([]),
      { cancel: vi.fn() },
    )) as unknown as LiveSearchSql, {
      setStatementTimeout: vi.fn(async () => undefined),
      unsafe: () => Object.assign(Promise.reject(timeoutError), { cancel: vi.fn() }),
    });
    const discard = vi.fn(async () => undefined);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: {
        open: async () => ({ sql, close: vi.fn(async () => undefined), discard }),
      },
    });

    await expect(provider.search({
      q: "검색어 확장",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
      deadlineAt: Date.now() + 2_000,
    })).resolves.toMatchObject({
      results: [],
      session_results: [],
      search_status: {
        search: { status: "partial", stage: "lexical", reason: "timeout" },
        query_expansion: { status: "skipped", latency_ms: 0 },
        session_sources: {
          metadata: { status: "partial", reason: "timeout" },
          original_body: { status: "deferred" },
          semantic_body: { status: "deferred" },
        },
      },
    });
    expect(sql.setStatementTimeout).toHaveBeenCalledTimes(4);
    expect(discard).not.toHaveBeenCalled();
  });

  it("returns at the deadline when cancel fails and the owned connection is discarded", async () => {
    let announceDispatch!: () => void;
    let rejectPending!: (error: Error) => void;
    const dispatched = new Promise<void>((resolve) => { announceDispatch = resolve; });
    const cancelError = new Error("cancel request failed");
    const cancel = vi.fn(() => { throw cancelError; });
    const discard = vi.fn(async () => rejectPending(new Error("connection discarded")));
    const close = vi.fn(async () => undefined);
    const pendingQuery = () => {
      announceDispatch();
      const pending = new Promise<readonly Record<string, unknown>[]>((_resolve, reject) => {
        rejectPending = reject;
      });
      return Object.assign(pending, { cancel, canceller: () => Promise.resolve(cancel()) });
    };
    const sql = Object.assign(pendingQuery, { unsafe: pendingQuery }) as unknown as LiveSearchSql;
    const onCancelError = vi.fn();
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: {
        open: async () => ({ sql, close, discard }),
      },
      onCancelError,
    });
    const startedAt = Date.now();
    const search = provider.search({
      q: "예전에 하던 대화를 찾아 이어가기",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
      deadlineAt: startedAt + 1_500,
    });

    await dispatched;
    const response = await search;

    expect(response.search_status).toMatchObject({
      search: { status: "partial", stage: "lexical", reason: "timeout" },
      db_cancel: "failed",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(onCancelError).toHaveBeenCalledOnce();
    expect(onCancelError).toHaveBeenCalledWith(cancelError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("does not dispatch a search statement if abort interrupts its timeout update", async () => {
    const controller = new AbortController();
    let announceTimeoutUpdate!: () => void;
    const timeoutUpdateStarted = new Promise<void>((resolve) => {
      announceTimeoutUpdate = resolve;
    });
    const setStatementTimeout = vi.fn(() => {
      announceTimeoutUpdate();
      return new Promise<void>(() => {});
    });
    const query = vi.fn(() => Object.assign(
      Promise.resolve<readonly Record<string, unknown>[]>([]),
      { cancel: vi.fn() },
    ));
    const discard = vi.fn(async () => undefined);
    const sql = Object.assign(query, {
      setStatementTimeout,
      unsafe: vi.fn(() => Object.assign(
        Promise.resolve<readonly Record<string, unknown>[]>([]),
        { cancel: vi.fn() },
      )),
    }) as unknown as LiveSearchSql;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: {
        open: async () => ({ sql, close: vi.fn(async () => undefined), discard }),
      },
    });
    const search = provider.search({
      q: "검색 결과에서 연결된 일을 바로 열기",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
      signal: controller.signal,
    });

    await timeoutUpdateStarted;
    controller.abort();

    await expect(search).resolves.toMatchObject({
      search_status: {
        search: { status: "partial", stage: "lexical", reason: "cancelled" },
      },
    });
    expect(setStatementTimeout).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
  });

  it("marks a deadline before lexical SQL as incomplete instead of a zero-result search", async () => {
    const open = vi.fn(async () => {
      throw new Error("connection must not open after the deadline");
    });
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: { open },
    });

    await expect(provider.search({
      q: "피드 검색",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
      deadlineAt: Date.now() - 1,
    })).resolves.toMatchObject({
      results: [],
      session_results: [],
      search_status: {
        search: { status: "partial", stage: "lexical", reason: "timeout" },
        query_expansion: { status: "skipped", latency_ms: 0 },
      },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps a concurrent request on its own search connection", async () => {
    const controller = new AbortController();
    let announceFirstDispatch!: () => void;
    let rejectFirst!: (error: Error) => void;
    const firstDispatched = new Promise<void>((resolve) => {
      announceFirstDispatch = resolve;
    });
    const firstCancel = vi.fn(() => rejectFirst(new Error("cancelled")));
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstCalls: string[] = [];
    let opened = 0;
    const factory = {
      async open() {
        opened += 1;
        if (opened === 1) {
          const firstPendingQuery = (text: string) => {
            firstCalls.push(text);
            announceFirstDispatch();
            const pending = new Promise<readonly Record<string, unknown>[]>(
              (_resolve, reject) => { rejectFirst = reject; },
            );
            return Object.assign(pending, {
              cancel: firstCancel,
              canceller: () => Promise.resolve(firstCancel()),
            });
          };
          const sql = Object.assign(
            (strings: TemplateStringsArray) => firstPendingQuery(strings.join("?")),
            { unsafe: (text: string) => firstPendingQuery(text) },
          ) as unknown as LiveSearchSql;
          return { sql, close: firstClose };
        }
        const sql = Object.assign(
          (_strings: TemplateStringsArray) => Object.assign(
            Promise.resolve<readonly Record<string, unknown>[]>([]),
            { cancel: vi.fn() },
          ),
          {
            unsafe: () => Object.assign(
              Promise.resolve<readonly Record<string, unknown>[]>([]),
              { cancel: vi.fn() },
            ),
          },
        ) as unknown as LiveSearchSql;
        return { sql, close: secondClose };
      },
    };
    const provider = createLiveCogitoSearchProvider({ searchDbConnectionFactory: factory });
    const params = {
      q: "검색어",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
    } as const;

    const first = provider.search({ ...params, signal: controller.signal });
    await firstDispatched;
    const second = provider.search(params);
    await expect(second).resolves.toMatchObject({
      results: [],
      navigation_results: [],
      session_results: [],
    });
    controller.abort();
    await expect(first).resolves.toMatchObject({
      search_status: {
        query_expansion: { status: "skipped", latency_ms: 0 },
      },
    });

    expect(opened).toBe(2);
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(firstCalls).toHaveLength(1);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it("reports connection cleanup failure without retaining a concurrency slot", async () => {
    let opens = 0;
    const closeError = new Error("close failed");
    const onCancelError = vi.fn();
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: {
        async open() {
          opens += 1;
          return {
            sql: createSqlHarness(() => []).sql,
            close: async () => {
              if (opens === 1) throw closeError;
            },
          };
        },
      },
      onCancelError,
    });
    const params = {
      q: "검색어",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
    } as const;

    await expect(provider.search(params)).resolves.toMatchObject({
      search_status: { db_cancel: "failed" },
    });
    await expect(provider.search(params)).resolves.toMatchObject({
      results: [],
      session_results: [],
    });
    expect(opens).toBe(2);
    expect(onCancelError).toHaveBeenCalledWith(closeError);
  });
});

function createSqlHarness(
  respond: (text: string, values: unknown[]) => readonly Record<string, unknown>[],
) {
  const calls: SqlCall[] = [];
  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const queryKinds = Array.isArray(values[1]) ? values[1] as string[] : ["original"];
    const rows = respond(text, values).map((row) => ({
      query_kind: queryKinds[0] ?? "original",
      ...row,
    }));
    return Object.assign(Promise.resolve(rows), {
      cancel: () => undefined,
    });
  };
  const sql = Object.assign((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => run(strings.join("?"), values), {
    unsafe: (text: string, values: readonly unknown[] = []) => run(text, [...values]),
  }) as unknown as LiveSearchSql;
  return { sql, calls };
}

function connectionFactoryFor(sql: LiveSearchSql) {
  const searchSql = sql.unsafe === undefined
    ? Object.assign(sql, {
      unsafe: () => Object.assign(Promise.resolve([]), { cancel: () => undefined }),
    }) as LiveSearchSql
    : sql;
  return {
    open: async () => ({
      sql: searchSql,
      close: async () => undefined,
    }),
  };
}
