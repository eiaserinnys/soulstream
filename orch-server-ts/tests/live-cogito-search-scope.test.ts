import { describe, expect, it } from "vitest";

import {
  createLiveCogitoSearchProvider,
  type LiveSearchSql,
} from "../src/index.js";

describe("live Cogito derived-text search scope", () => {
  it("returns digest candidates only when a derived-text flag is enabled", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const text = strings.join("?");
      calls.push({ text, values });
      const booleanValues = values.filter((value) => typeof value === "boolean");
      const includeHighlight = booleanValues[2];
      const includeStory = booleanValues[3];
      if (
        text.includes("FROM session_digests")
        && (includeHighlight === true || includeStory === true)
      ) {
        return Promise.resolve([{
          query: "needle",
          query_kind: "original",
          query_order: 1,
          id: 20,
          session_id: "sess-1",
          event_type: "session_story",
          searchable_text: "needle story",
          created_at: "2026-01-01T00:00:00.000Z",
          score: 0.8,
          match_source: "story",
        }]);
      }
      return Promise.resolve([]);
    }) as unknown as LiveSearchSql;
    const provider = createLiveCogitoSearchProvider({
      searchDbConnectionFactory: {
        open: async () => ({
          sql,
          close: async () => undefined,
        }),
      },
    });

    await provider.search({
      q: "needle",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: false,
      include_highlight: false,
      include_story: false,
    });
    expect(calls[0]?.values.filter((value) => typeof value === "boolean"))
      .toEqual([false, false, false, false, false]);

    const response = await provider.search({
      q: "needle",
      top_k: 10,
      search_session_id: false,
      include_turn_summaries: true,
      include_highlight: false,
      include_story: true,
    });
    expect(calls.some((call) => call.text.includes("FROM session_digests"))).toBe(true);
    expect(response.results).toEqual([
      expect.objectContaining({ match_source: "story" }),
    ]);
  });
});
