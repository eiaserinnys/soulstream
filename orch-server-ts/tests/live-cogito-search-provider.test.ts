import { describe, expect, it, vi } from "vitest";

import {
  createLiveCogitoSearchProvider,
  type LiveSearchSql,
} from "../src/index.js";
import type { SearchQueryExpander } from "../src/search/search_query_expander.js";

type SqlCall = { text: string; values: unknown[] };

describe("live Cogito search provider", () => {
  it("caps product expansion at eight seconds under its separate ten-second request deadline", async () => {
    const harness = createSqlHarness(() => []);
    const expansionTimeouts: number[] = [];
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
      queryExpander: {
        expand: async (_query, timeoutMs) => {
          expansionTimeouts.push(timeoutMs);
          return { queries: ["semantic variant"], latencyMs: 1, skipped: false };
        },
      },
    });

    await provider.search({
      q: "paraphrased query",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "expanded",
    });

    expect(expansionTimeouts).toEqual([8_000]);
  });

  it("reports semantic SQL and projection timing without changing the public payload", async () => {
    const harness = createSqlHarness(() => []);
    const observations: Array<Record<string, unknown>> = [];
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
      queryExpander: {
        expand: async () => ({ queries: ["expanded semantic query"], latencyMs: 8, skipped: false }),
      },
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
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(expect.objectContaining({
      lexicalSqlMs: expect.any(Number),
      semanticSqlMs: expect.any(Number),
      projectionMs: expect.any(Number),
      totalMs: expect.any(Number),
    }));
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
    const queryExpander = { expand: vi.fn() } as unknown as SearchQueryExpander;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
      queryExpander,
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
    expect(queryExpander.expand).not.toHaveBeenCalled();
    expect(harness.calls.filter((call) => call.text.includes("event_search(")).length).toBe(0);
    expect(response.search_status?.session_sources).toEqual({
      metadata: { status: "complete" },
      original_body: { status: "deferred" },
      semantic_body: { status: "deferred" },
    });
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
    const promptTokenCall = metadataCalls.find((call) => call.text.includes("session_search_tokens(candidate.prompt)"));
    expect(metadataCalls).toHaveLength(4);
    expect(titleTokenCall?.text).toContain("&&");
    expect(titleTokenCall?.text).toContain("candidate.folder_id = ANY");
    expect(titleTokenCall?.text).toContain("bounded_metadata AS MATERIALIZED");
    expect(promptTokenCall?.text).toContain("&&");
  });

  it("keeps completed metadata candidates when the prompt-token source times out", async () => {
    const calls: SqlCall[] = [];
    const titleRow = {
      query: "피드 검색 세션",
      query_kind: "original",
      query_order: 1,
      id: null,
      session_id: "title-candidate",
      event_type: "session_metadata",
      searchable_text: "피드 검색 세션 업무 자동 선택 수정",
      created_at: "2026-09-23T00:00:00.000Z",
      score: 1.85,
      match_source: "title",
      relevance_source: "title",
      display_name: "피드 검색 세션 업무 자동 선택 수정",
      session_prompt: "",
      folder_id: "folder-a",
      node_id: "node-a",
      status: "completed",
      backend: null,
      parent_session_id: null,
      session_updated_at: "2026-09-23T00:00:00.000Z",
      task_id: null,
      task_title: null,
    };
    const promptTimeout = Object.assign(new Error("statement timeout"), { code: "57014" });
    const run = (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("session_metadata") && text.includes("session_search_tokens(candidate.prompt)")) {
        return Object.assign(Promise.reject(promptTimeout), { cancel: vi.fn() });
      }
      if (text.includes("session_metadata")) {
        return Object.assign(Promise.resolve([titleRow]), { cancel: vi.fn() });
      }
      return Object.assign(Promise.resolve([]), { cancel: vi.fn() });
    };
    const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) =>
      run(strings.join("?"), values), {
      unsafe: (text: string, values: readonly unknown[] = []) => run(text, [...values]),
    }) as unknown as LiveSearchSql;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(sql),
    });

    const response = await provider.search({
      q: "피드 검색 세션",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "lexical",
    });

    const metadataCalls = calls.filter((call) => call.text.includes("session_metadata"));
    expect(metadataCalls).toHaveLength(4);
    expect(metadataCalls[0]?.text).toContain("session_search_index_prefix(candidate.display_name_search_key)");
    expect(metadataCalls[1]?.text).toContain("session_search_index_prefix(candidate.prompt_search_key)");
    expect(metadataCalls[2]?.text).toContain("session_search_tokens(candidate.display_name)");
    expect(metadataCalls[2]?.text).not.toContain("session_search_tokens(candidate.prompt)");
    expect(metadataCalls[3]?.text).toContain("session_search_tokens(candidate.prompt)");
    expect(response.session_results?.map((row) => row.session_id)).toContain("title-candidate");
    expect(response.search_status?.session_sources?.metadata).toEqual({ status: "partial", reason: "timeout" });
    expect(response.search_status?.search).toEqual({ status: "partial", stage: "lexical", reason: "timeout" });
  });

  it("keeps long original queries on the exact/prefix path in lexical and expanded search", async () => {
    const harness = createSqlHarness(() => []);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
      queryExpander: {
        expand: async () => ({
          queries: ["세션 업무 자동 선택"],
          latencyMs: 1,
          skipped: false,
        }),
      },
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
    await provider.search({ ...params, session_search_mode: "expanded" });

    const metadataCalls = harness.calls.filter((call) => call.text.includes("session_metadata"));
    expect(metadataCalls.length).toBeGreaterThanOrEqual(3);
    expect(metadataCalls.every((call) => !call.text.includes("session_search_tokens("))).toBe(true);
  });

  it("preserves metadata and successful semantic rows when original body search times out", async () => {
    const calls: SqlCall[] = [];
    let bodyQueries = 0;
    const metadataRow = {
      query: "피드 검색 세션",
      query_kind: "original",
      query_order: 1,
      id: null,
      session_id: "metadata-session",
      event_type: "session_metadata",
      searchable_text: "피드 검색 세션",
      created_at: "2026-09-23T00:00:00.000Z",
      score: 2,
      match_source: "title",
      relevance_source: "title",
      display_name: "피드 검색 세션",
      session_prompt: "",
      folder_id: "folder-a",
      node_id: "node-a",
      status: "completed",
      backend: null,
      parent_session_id: null,
      session_updated_at: "2026-09-23T00:00:00.000Z",
      task_id: null,
      task_title: null,
    };
    const sql = Object.assign((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const text = strings.join("?");
      calls.push({ text, values });
      if (text.includes("event_search(")) {
        bodyQueries += 1;
        if (bodyQueries === 1) {
          return Object.assign(Promise.reject({ code: "57014" }), { cancel: vi.fn() });
        }
        return Object.assign(Promise.resolve([{
          query: "continue previous work",
          query_kind: "semantic_1",
          query_order: 1,
          id: 19,
          session_id: "semantic-session",
          event_type: "assistant_message",
          searchable_text: "continue previous work from the last implementation",
          created_at: "2026-09-23T00:00:00.000Z",
          score: 0.8,
          match_source: "message",
          relevance_source: "assistant_message",
          display_name: "Earlier implementation",
          session_prompt: "",
          folder_id: "folder-a",
          node_id: "node-a",
          status: "completed",
          backend: null,
          parent_session_id: null,
          session_updated_at: "2026-09-23T00:00:00.000Z",
          task_id: null,
          task_title: null,
        }]), { cancel: vi.fn() });
      }
      return Object.assign(Promise.resolve([]), { cancel: vi.fn() });
    }, {
      unsafe: (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return Object.assign(Promise.resolve([metadataRow]), { cancel: vi.fn() });
      },
    }) as unknown as LiveSearchSql;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(sql),
      queryExpander: {
        expand: async () => ({
          queries: ["continue previous work"],
          latencyMs: 7,
          skipped: false,
        }),
      },
    });

    const response = await provider.search({
      q: "피드 검색 세션",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      session_search_mode: "expanded",
    });

    expect(bodyQueries).toBe(2);
    expect(response.session_results?.map((row) => row.session_id)).toEqual(
      expect.arrayContaining(["metadata-session", "semantic-session"]),
    );
    expect(response.search_status?.query_expansion.status).toBe("expanded");
    expect(response.search_status?.session_sources).toEqual({
      metadata: { status: "complete" },
      original_body: { status: "partial", reason: "timeout" },
      semantic_body: { status: "complete" },
    });
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

  it("applies allowed folders inside event, session, digest, metadata, and navigation candidates", async () => {
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
      allowedFolderIds: ["visible-root", "visible-child"],
    });

    expect(harness.calls).toHaveLength(6);
    const metadataCalls = harness.calls.filter((call) => call.text.includes("session_metadata"));
    const bodyCall = harness.calls.find((call) => call.text.includes("event_search("));
    const navigationCall = harness.calls.find((call) => call.text.includes("FROM folders"));
    expect(metadataCalls).toHaveLength(4);
    expect(bodyCall?.text).toContain("event_search(");
    expect(bodyCall?.text).toContain("session_id_search(");
    expect(bodyCall?.text).toContain("digest_session.folder_id = ANY");
    expect(bodyCall?.text.match(/event_search\(/g)).toHaveLength(1);
    expect(bodyCall?.values).toContain(1);
    expect(bodyCall?.values).toContain(25);
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
      signal: controller.signal,
    });

    await dispatched;
    controller.abort();

    await expect(search).resolves.toMatchObject({
      results: [],
      navigation_results: [],
      session_results: [],
      search_status: {
        query_expansion: { status: "partial", reason: "configuration" },
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps semantic expansion alive when the original body query fails", async () => {
    const databaseError = new Error("database unavailable");
    let expansionSignal: AbortSignal | undefined;
    let bodyQueries = 0;
    const queryExpander: SearchQueryExpander = {
      expand: async (_query, _timeoutMs, signal) => {
        expansionSignal = signal;
        return { queries: ["semantic result"], latencyMs: 2, skipped: false };
      },
    };
    const sql = Object.assign((strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (!text.includes("event_search(")) {
        return Object.assign(Promise.resolve([]), { cancel: vi.fn() });
      }
      bodyQueries += 1;
      if (bodyQueries === 1) {
        return Object.assign(Promise.reject(databaseError), { cancel: vi.fn() });
      }
      return Object.assign(Promise.resolve([{
        query: "semantic result",
        query_kind: "semantic_1",
        query_order: 1,
        id: 9,
        session_id: "semantic-session",
        event_type: "assistant_message",
        searchable_text: "semantic result from the completed work",
        created_at: "2026-09-23T00:00:00.000Z",
        score: 0.8,
        match_source: "message",
        relevance_source: "assistant_message",
        display_name: "Semantic work",
        session_prompt: "",
        folder_id: "folder-a",
      }]), { cancel: vi.fn() });
    }, {
      unsafe: () => Object.assign(Promise.resolve([]), { cancel: vi.fn() }),
    }) as unknown as LiveSearchSql;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(sql),
      queryExpander,
    });

    const response = await provider.search({
      q: "검색어",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
    });

    expect(expansionSignal?.aborted).toBe(false);
    expect(bodyQueries).toBe(2);
    expect(response.session_results?.map((row) => row.session_id)).toContain("semantic-session");
    expect(response.search_status?.session_sources).toMatchObject({
      original_body: { status: "partial", reason: "error" },
      semantic_body: { status: "complete" },
    });
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
    expect(sql.setStatementTimeout).toHaveBeenCalledTimes(5);
    expect(discard).not.toHaveBeenCalled();
  });

  it("does not report semantic search complete when an expander adds no variant", async () => {
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(createSqlHarness(() => []).sql),
      queryExpander: {
        expand: async () => ({ queries: [], latencyMs: 4, skipped: false }),
      },
    });

    await expect(provider.search({
      q: "의역 검색어",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
    })).resolves.toMatchObject({
      search_status: {
        query_expansion: { status: "partial", reason: "model_error", latency_ms: 4 },
      },
    });
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

  it("marks semantic search partial when cancellation stops the expanded-query SQL", async () => {
    const controller = new AbortController();
    let announceSemanticDispatch!: () => void;
    let rejectSemantic!: (error: Error) => void;
    const semanticDispatched = new Promise<void>((resolve) => {
      announceSemanticDispatch = resolve;
    });
    const cancel = vi.fn(() => rejectSemantic(new Error("cancelled")));
    let calls = 0;
    const sql = ((strings: TemplateStringsArray) => {
      calls += 1;
      if (calls === 1) {
        return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
          cancel: vi.fn(),
        });
      }
      announceSemanticDispatch();
      const pending = new Promise<readonly Record<string, unknown>[]>((_resolve, reject) => {
        rejectSemantic = reject;
      });
      return Object.assign(pending, { cancel, canceller: () => Promise.resolve(cancel()) });
    }) as unknown as LiveSearchSql;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(sql),
      queryExpander: {
        expand: async () => ({
          queries: ["피드 결과 자동 선택"],
          latencyMs: 17,
          skipped: false,
        }),
      },
    });
    const search = provider.search({
      q: "피드검색",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      signal: controller.signal,
    });

    await semanticDispatched;
    controller.abort();

    await expect(search).resolves.toMatchObject({
      search_status: {
        query_expansion: {
          status: "partial",
          reason: "cancelled",
          latency_ms: 17,
        },
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(calls).toBe(2);
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
      deadlineAt: Date.now() - 1,
    })).resolves.toMatchObject({
      results: [],
      session_results: [],
      search_status: {
        search: { status: "partial", stage: "lexical", reason: "timeout" },
        query_expansion: { status: "partial", reason: "timeout" },
      },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("aborts query expansion at the single request deadline and skips later SQL", async () => {
    const harness = createSqlHarness(() => []);
    let expansionAborted = false;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: connectionFactoryFor(harness.sql),
      queryExpander: {
        expand: async (_query, _timeoutMs, signal) => await new Promise((_, reject) => {
          if (signal?.aborted) {
            expansionAborted = true;
            reject(new Error("cancelled"));
            return;
          }
          signal?.addEventListener("abort", () => {
            expansionAborted = true;
            reject(new Error("cancelled"));
          }, { once: true });
        }),
      },
    });

    const startedAt = Date.now();
    await expect(provider.search({
      q: "예전에 하던 대화를 찾아 이어가기",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
      deadlineAt: startedAt + 1_200,
    })).resolves.toMatchObject({
      search_status: {
        search: { status: "partial", stage: "navigation", reason: "timeout" },
        query_expansion: { status: "partial", reason: "timeout" },
      },
    });
    expect(expansionAborted).toBe(true);
    expect(harness.calls).toHaveLength(5);
    expect(harness.calls.filter((call) => call.text.includes("session_metadata"))).toHaveLength(4);
    expect(harness.calls.filter((call) => call.text.includes("event_search(")).length).toBe(1);
    expect(harness.calls.some((call) => call.text.includes("FROM folders"))).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_800);
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
        query_expansion: { status: "partial", reason: "configuration" },
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
