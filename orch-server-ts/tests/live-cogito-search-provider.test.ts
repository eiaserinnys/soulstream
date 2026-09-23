import { describe, expect, it, vi } from "vitest";

import {
  createLiveCogitoSearchProvider,
  type LiveSearchSql,
} from "../src/index.js";
import type { SearchQueryExpander } from "../src/search/search_query_expander.js";

type SqlCall = { text: string; values: unknown[] };

describe("live Cogito search provider", () => {
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

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.text).toContain("event_search(");
    expect(harness.calls[0]?.text).toContain("session_id_search(");
    expect(harness.calls[0]?.text).toContain("digest_session.folder_id = ANY");
    expect(harness.calls[0]?.text).toContain("candidate.folder_id = ANY");
    expect(harness.calls[0]?.text).toContain("primary_session_item.container_kind = 'task'");
    expect(harness.calls[0]?.text).toContain("primary_session_item.membership_kind = 'primary'");
    expect(harness.calls[0]?.text.match(/event_search\(/g)).toHaveLength(2);
    expect(harness.calls[0]?.values).toContain(1);
    expect(harness.calls[0]?.values).toContain(25);
    expect(harness.calls[0]?.values).toContainEqual(["visible-root", "visible-child"]);
    expect(harness.calls[1]?.text).toContain("f.id = ANY");
    expect(harness.calls[1]?.values).toContainEqual(["visible-root", "visible-child"]);
  });

  it("cancels the active query and dispatches no later query after abort", async () => {
    const controller = new AbortController();
    let announceDispatch!: () => void;
    let rejectActive!: (error: Error) => void;
    const dispatched = new Promise<void>((resolve) => { announceDispatch = resolve; });
    const cancel = vi.fn(() => rejectActive(new Error("cancelled")));
    const calls: string[] = [];
    const close = vi.fn(async () => undefined);
    const sql = ((strings: TemplateStringsArray) => {
      calls.push(strings.join("?"));
      announceDispatch();
      const pending = new Promise<readonly Record<string, unknown>[]>((_resolve, reject) => {
        rejectActive = reject;
      });
      return Object.assign(pending, { cancel, canceller: () => Promise.resolve(cancel()) });
    }) as unknown as LiveSearchSql;
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
        query_expansion: { status: "partial", reason: "cancelled" },
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts a pending query expansion when the lexical database query fails", async () => {
    const databaseError = new Error("database unavailable");
    let expansionSignal: AbortSignal | undefined;
    let signalExpansionStarted!: () => void;
    let expansionAbortObserved = false;
    const expansionStarted = new Promise<void>((resolve) => {
      signalExpansionStarted = resolve;
    });
    const queryExpander: SearchQueryExpander = {
      expand: async (_query, _timeoutMs, signal) => {
        expansionSignal = signal;
        signalExpansionStarted();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            expansionAbortObserved = true;
            reject(signal.reason);
          }, { once: true });
        });
        return { queries: [], latencyMs: 0, skipped: false };
      },
    };
    const cancel = vi.fn();
    const sql = (() => Object.assign(
      Promise.reject(databaseError),
      { cancel },
    )) as unknown as LiveSearchSql;
    const close = vi.fn(async () => undefined);
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: {
        open: async () => ({ sql, close }),
      },
      queryExpander,
    });

    await expect(provider.search({
      q: "검색어",
      top_k: 5,
      search_session_id: true,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
      include_session_results: true,
    })).rejects.toBe(databaseError);
    await expansionStarted;

    expect(expansionSignal?.aborted).toBe(true);
    expect(expansionAbortObserved).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns explicit partial status when PostgreSQL reaches the query-local timeout", async () => {
    const timeoutError = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const sql = Object.assign((() => Object.assign(
      Promise.reject(timeoutError),
      { cancel: vi.fn() },
    )) as unknown as LiveSearchSql, {
      setStatementTimeout: vi.fn(async () => undefined),
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
      deadlineAt: Date.now() + 2_000,
    })).resolves.toMatchObject({
      results: [],
      session_results: [],
      search_status: {
        search: { status: "partial", stage: "lexical", reason: "timeout" },
        query_expansion: { status: "partial", reason: "timeout" },
      },
    });
    expect(sql.setStatementTimeout).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
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
    const sql = (() => {
      announceDispatch();
      const pending = new Promise<readonly Record<string, unknown>[]>((_resolve, reject) => {
        rejectPending = reject;
      });
      return Object.assign(pending, { cancel, canceller: () => Promise.resolve(cancel()) });
    }) as unknown as LiveSearchSql;
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
    const sql = Object.assign(query, { setStatementTimeout }) as unknown as LiveSearchSql;
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
    expect(harness.calls).toHaveLength(1);
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
          const sql = ((strings: TemplateStringsArray) => {
            firstCalls.push(strings.join("?"));
            announceFirstDispatch();
            const pending = new Promise<readonly Record<string, unknown>[]>(
              (_resolve, reject) => { rejectFirst = reject; },
            );
            return Object.assign(pending, {
              cancel: firstCancel,
              canceller: () => Promise.resolve(firstCancel()),
            });
          }) as unknown as LiveSearchSql;
          return { sql, close: firstClose };
        }
        const sql = ((_strings: TemplateStringsArray) => Object.assign(
          Promise.resolve<readonly Record<string, unknown>[]>([]),
          { cancel: vi.fn() },
        )) as unknown as LiveSearchSql;
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
        query_expansion: { status: "partial", reason: "cancelled" },
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
  const sql = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join("?");
    calls.push({ text, values });
    const queryKinds = Array.isArray(values[1]) ? values[1] as string[] : ["original"];
    const rows = respond(text, values).map((row) => ({
      query_kind: queryKinds[0] ?? "original",
      ...row,
    }));
    return Object.assign(Promise.resolve(rows), {
      cancel: () => undefined,
    });
  }) as unknown as LiveSearchSql;
  return { sql, calls };
}

function connectionFactoryFor(sql: LiveSearchSql) {
  return {
    open: async () => ({
      sql,
      close: async () => undefined,
    }),
  };
}
