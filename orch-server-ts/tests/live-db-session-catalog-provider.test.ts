import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createLiveDbCatalogRepository,
  parseOrchServerConfig,
  type LivePostgresSql,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB session catalog provider", () => {
  it("uses Python catalog DB functions and preserves caller_info as route input only", async () => {
    const harness = createSqlHarness();
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await repository.sessionCatalogProvider.renameSession(
      "sess-1",
      "Renamed",
      { source: "browser" },
    );
    await repository.sessionCatalogProvider.moveSessionsToFolder(
      ["sess-1", "sess-2"],
      "folder-1",
      { source: "slack" },
    );
    await repository.sessionCatalogProvider.updateSessionCatalog(
      "sess-3",
      { folderId: null, displayName: null },
      { source: "agent" },
    );
    await repository.sessionCatalogProvider.deleteSession("sess-4");
    await repository.sessionCatalogProvider.updateReadPosition("sess-5", 42);

    expect(harness.normalizedCalls()).toEqual([
      "SELECT session_rename(?, ?)",
      "SELECT session_assign_folder(?, ?)",
      "SELECT session_assign_folder(?, ?)",
      "SELECT session_assign_folder(?, ?)",
      "SELECT session_rename(?, ?)",
      "SELECT session_delete(?)",
      "SELECT session_update_read_position(?, ?)",
    ]);
    expect(harness.calls.map((call) => call.values)).toEqual([
      ["sess-1", "Renamed"],
      ["sess-1", "folder-1"],
      ["sess-2", "folder-1"],
      ["sess-3", null],
      ["sess-3", null],
      ["sess-4"],
      ["sess-5", 42],
    ]);
  });

  it("normalizes event_read rows for session cards through the route", async () => {
    const harness = createSqlHarness((text) =>
      text.includes("event_read")
        ? [
            {
              id: 1,
              event_type: "assistant_message",
              payload: "{\"text\":\"parsed\"}",
              created_at: "2026-07-09T00:00:00.000Z",
            },
          ]
        : [],
    );
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });
    const app = createApp({
      config,
      sessionCatalogRoutes: { provider: repository.sessionCatalogProvider },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/cards",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: 1,
        type: "assistant_message",
        payload: { text: "parsed" },
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ]);
    expect(harness.normalizedCalls()).toEqual([
      "SELECT * FROM event_read(?, ?, ?, ?)",
    ]);
    expect(harness.calls[0]?.values).toEqual(["sess-1", 0, null, null]);

    await app.close();
  });
});

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}
