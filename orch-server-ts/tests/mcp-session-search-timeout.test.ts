import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHistorySearchDeadlineError as RequestDeadlineError } from "@soulstream/search-contract";
import { SessionHistorySearchDeadlineError as DatabaseDeadlineError, SessionHistorySearchRepository } from "../src/control_plane/repositories/session_history_search_repository.js";
import { LiveSearchDeadlineError } from "../src/runtime/live_db_sql.js";
import { sessionReadAdapter } from "../src/mcp/session_read_adapter.js";
import { sessionQueryHandlers } from "../src/mcp/session_query_handlers.js";
import type { PersistenceHostRepositories } from "../src/control_plane/persistence_host_runtime.js";
import type { McpHostOptions } from "../src/mcp/types.js";

const guidance = "검색 시간이 초과됐습니다. 검색어를 더 구체화하거나 세션 범위를 지정해 주세요.";

function setup(search: (params: unknown, signal: AbortSignal) => Promise<unknown>) {
  const repositories = { historySearch: { search } } as unknown as PersistenceHostRepositories;
  const warn = vi.fn();
  const options = { sessions: { repositoryProvider: async () => repositories }, cluster: { logger: { warn } } } as unknown as McpHostOptions;
  const call = (signal = new AbortController().signal) => sessionQueryHandlers.search_session_history(
    options, { query: "private query" }, { principal: "external", callerSessionId: null, nodeId: "test", signal },
  );
  return { repositories, warn, call };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("session history search errors", () => {
  it("preserves the repository cause with the existing host error", async () => {
    const cause = new Error("connection refused");
    const { repositories } = setup(async () => { throw cause; });
    const adapter = sessionReadAdapter(repositories);
    await expect(adapter.searchSessionHistory({
      query: "test", sessionIds: null, limit: 10, eventTypes: null,
      searchSessionId: false, includeHighlight: false, includeStory: false,
    }, new AbortController().signal)).rejects.toMatchObject({
      message: "session-data host history_search failed", cause,
    });
  });

  it.each([
    [new DatabaseDeadlineError(), "database_timeout"],
    [new LiveSearchDeadlineError(), "request_deadline"],
    [new RequestDeadlineError(), "request_deadline"],
  ])(
    "provides actionable guidance for %s", async (cause, kind) => {
      const { call, warn } = setup(async () => { throw cause; });
      const result = await call();
      expect(result.structuredContent).toEqual({ error: guidance });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        kind,
        elapsed_ms: expect.any(Number),
        scoped: false,
        event_type_count: 0,
        top_k: 10,
      }), "session history search timed out");
    },
  );

  it("recognizes the outer request deadline after the adapter wraps its cause", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let searchStarted!: () => void;
    const started = new Promise<void>((resolve) => { searchStarted = resolve; });
    const { call } = setup(async (_params, signal) => await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      searchStarted();
    }));
    const result = call();
    await started;
    deadline.abort(new DOMException("deadline expired", "TimeoutError"));
    expect((await result).structuredContent).toEqual({ error: guidance });
  });

  it("reports a general failure with its cause in the warning and without logging content", async () => {
    const cause = Object.assign(new Error("private query and token"), { code: "ECONNREFUSED" });
    const { call, warn } = setup(async () => { throw cause; });
    const result = await call();
    expect(result.structuredContent).toEqual({ error: "session-data host history_search failed" });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).toContain("ECONNREFUSED");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private query");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("token");
  });

  it("does not misclassify a generic error carrying a 504 status as a timeout", async () => {
    const { call } = setup(async () => { throw Object.assign(new Error("other failure"), { statusCode: 504 }); });
    expect((await call()).structuredContent).toEqual({ error: "session-data host history_search failed" });
  });

  it.each([
    ["canceling statement due to statement timeout", guidance],
    ["canceling statement due to user request", "session-data host history_search failed"],
  ])("distinguishes PostgreSQL cancellation: %s", async (message, expected) => {
    const failure = Object.assign(new Error(message), { code: "57014" });
    const repository = new SessionHistorySearchRepository(
      { open: async () => { throw failure; } }, {} as never, {} as never,
    );
    const { call } = setup((params, signal) => repository.search(params as never, signal));
    expect((await call()).structuredContent).toEqual({ error: expected });
  });
});
