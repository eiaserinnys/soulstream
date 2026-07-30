import { describe, expect, it } from "vitest";

import {
  createLiveCogitoSearchProvider,
  type LivePostgresSql,
} from "../src/index.js";

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
      sqlResolver: resolverFor(harness.sql),
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

  it("does not query session ids when the option is disabled and keeps tools opt-in", async () => {
    const harness = createSqlHarness(() => []);
    const provider = createLiveCogitoSearchProvider({
      sqlResolver: resolverFor(harness.sql),
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

    expect(harness.calls.some((call) => call.text.includes("session_id_search"))).toBe(false);
    expect(harness.calls[0]?.values[3]).toEqual([
      "thinking",
      "tool_start",
      "tool_result",
    ]);
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
    return Promise.resolve(respond(text, values));
  }) as LivePostgresSql;
  Object.defineProperty(sql, "json", {
    value: (value: unknown) => value,
  });
  return { sql, calls };
}

function resolverFor(sql: LivePostgresSql) {
  return {
    resolveSql: async () => sql,
    close: async () => undefined,
  };
}
