import { describe, expect, it, vi } from "vitest";

import {
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  readonly text: string;
  readonly values: unknown[];
};

describe("live DB push eligibility", () => {
  it("loads session type and review_required from the canonical session row", async () => {
    const calls: SqlCall[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return [{ session_type: "claude", review_required: true }];
    }) as unknown as LivePostgresSql;
    const repository = createLiveDbCatalogRepository({ sql });

    await expect(repository.loadSessionReviewState("session-a")).resolves.toEqual({
      sessionType: "claude",
      reviewRequired: true,
    });

    expect(calls).toHaveLength(1);
    expect(normalizeSql(calls[0]?.text)).toContain(
      "SELECT session_type, review_required FROM sessions WHERE session_id = ? LIMIT 1",
    );
    expect(calls[0]?.values).toEqual(["session-a"]);
  });
});

function normalizeSql(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
