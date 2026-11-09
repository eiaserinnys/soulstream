import { describe, expect, it, vi } from "vitest";

import { SEARCH_DB_STATEMENT_TIMEOUT_MS } from "../src/index.js";
import { runSearchQuery } from "../src/runtime/live_session_search_candidates.js";
import type { LiveSearchPendingQuery, LiveSearchSql } from "../src/runtime/live_db_sql.js";

describe("runSearchQuery", () => {
  it("caps the statement timeout at the search DB timeout when the remaining budget is ample", async () => {
    const setStatementTimeout = vi.fn(async () => undefined);
    const sql = Object.assign(vi.fn(), { setStatementTimeout }) as unknown as LiveSearchSql;
    const pending = Object.assign(Promise.resolve([]), {
      cancel: vi.fn(),
    }) as unknown as LiveSearchPendingQuery<readonly Record<string, unknown>[]>;
    const activeQuery: { current?: LiveSearchPendingQuery<readonly Record<string, unknown>[]> } = {};

    const rows = await runSearchQuery(
      activeQuery,
      () => pending,
      undefined,
      Date.now() + 20_000,
      sql,
    );

    expect(rows).toEqual([]);
    expect(activeQuery.current).toBeUndefined();
    expect(setStatementTimeout).toHaveBeenCalledOnce();
    expect(setStatementTimeout).toHaveBeenCalledWith(SEARCH_DB_STATEMENT_TIMEOUT_MS);
  });
});
