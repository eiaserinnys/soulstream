import { describe, expect, it } from "vitest";

import {
  createLiveCogitoSearchProvider,
  type LivePostgresSql,
} from "../src/index.js";

describe("live Cogito derived-text search scope", () => {
  it("does not touch digests by default and queries them only for explicit flags", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const text = strings.join("?");
      calls.push({ text, values });
      if (text.includes("FROM session_digests")) {
        return Promise.resolve([{
          id: 20,
          session_id: "sess-1",
          event_type: "session_story",
          searchable_text: "needle story",
          score: 0.8,
          match_source: "story",
        }]);
      }
      return Promise.resolve([]);
    }) as unknown as LivePostgresSql;
    Object.defineProperty(sql, "json", { value: (value: unknown) => value });
    const provider = createLiveCogitoSearchProvider({
      sqlResolver: {
        resolveSql: async () => sql,
        close: async () => undefined,
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
    expect(calls.some((call) => call.text.includes("FROM session_digests"))).toBe(false);

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
