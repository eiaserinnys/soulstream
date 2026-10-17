import { describe, expect, it, vi } from "vitest";
import type { SessionEventAttachmentResponse } from "@soulstream/wire-schema/attachments";

import {
  createApp,
  parseOrchServerConfig,
  SessionResourceAccessError,
  type SessionHistoryProvider,
  type SessionResourceAccessProvider,
} from "../src/index.js";
import { createLiveSessionHistoryProvider } from "../src/runtime/live_session_history_provider.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("session event attachment route", () => {
  it("returns missing and unavailable items with private no-store headers", async () => {
    const responseBody: SessionEventAttachmentResponse = {
      event_id: 42,
      items: [
        {
          kind: "legacy",
          node_id: "node-1",
          path: "/session/files/missing.txt",
          name: "missing.txt",
          mime_type: null,
          byte_size: null,
          availability: "missing",
          read_context: { type: "session", id: "sess-1" },
        },
        {
          kind: "unavailable",
          attachment_id: "asset-1",
          name: null,
          availability: "unavailable",
          read_context: { type: "session", id: "sess-1" },
        },
      ],
    };
    const readEventAttachments = vi.fn(async () => responseBody);
    const { app, accessProvider } = createHarness({ readEventAttachments });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events/42/attachments",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("private");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.json()).toEqual(responseBody);
    expect(accessProvider.requireSessionAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1" }),
    );
    expect(readEventAttachments).toHaveBeenCalledWith("sess-1", 42);
    await app.close();
  });

  it("validates positive safe integer IDs and uses the session and event pair", async () => {
    const readEventAttachments = vi.fn(async () => null);
    const { app, accessProvider } = createHarness({ readEventAttachments });

    for (const eventId of ["0", "nope", "1.5", "9007199254740992"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/sess-1/events/${eventId}/attachments`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "ATTACHMENT_EVENT_INVALID_ID" },
      });
    }

    const missing = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events/43/attachments",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "ATTACHMENT_EVENT_NOT_FOUND" },
    });
    expect(readEventAttachments).toHaveBeenCalledTimes(1);
    expect(readEventAttachments).toHaveBeenCalledWith("sess-1", 43);
    expect(accessProvider.requireSessionAccess).toHaveBeenCalledTimes(5);
    await app.close();
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "SESSION_ACCESS_DENIED"],
  ])("does not call the provider when access returns %i", async (statusCode, code) => {
    const readEventAttachments = vi.fn(async () => null);
    const accessProvider = createAccessProvider(async () => {
      throw new SessionResourceAccessError(code, "Access denied", statusCode);
    });
    const { app } = createHarness({ readEventAttachments }, accessProvider);

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events/42/attachments",
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(readEventAttachments).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 503 when projection capability or access enforcement is unavailable", async () => {
    const provider = createHistoryProvider() as SessionHistoryProvider;
    const withAccess = createApp({
      config,
      sessionHistoryRoutes: { provider, accessProvider: createAccessProvider() },
    });
    const capabilityMissing = await withAccess.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events/42/attachments",
    });
    expect(capabilityMissing.statusCode).toBe(503);
    expect(capabilityMissing.json()).toMatchObject({
      error: { code: "ATTACHMENT_PROJECTION_UNAVAILABLE" },
    });
    await withAccess.close();

    const readEventAttachments = vi.fn(async () => null);
    const withoutAccess = createApp({
      config,
      sessionHistoryRoutes: { provider: createHistoryProvider({ readEventAttachments }) },
    });
    const accessMissing = await withoutAccess.inject({
      method: "GET",
      url: "/api/sessions/sess-1/events/42/attachments",
    });
    expect(accessMissing.statusCode).toBe(503);
    expect(accessMissing.json()).toMatchObject({
      error: { code: "ATTACHMENT_PROJECTION_UNAVAILABLE" },
    });
    expect(readEventAttachments).not.toHaveBeenCalled();
    await withoutAccess.close();
  });

  it("routes through the production live session history provider", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return [{ session_node_id: "node-1", event_type: "tool_start", payload: {} }];
    }) as unknown as LivePostgresSql;
    const provider = createLiveSessionHistoryProvider({
      sqlResolver: {
        resolveSql: async () => sql,
        close: async () => undefined,
      },
    });
    const app = createApp({
      config,
      sessionHistoryRoutes: { provider, accessProvider: createAccessProvider() },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-live/events/77/attachments",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ event_id: 77, items: [] });
    expect(calls).toEqual([
      {
        text: expect.stringContaining("JOIN events e ON e.session_id = s.session_id"),
        values: ["sess-live", 77],
      },
    ]);
    await app.close();
  });
});

function createHarness(
  overrides: Parameters<typeof createHistoryProvider>[0] = {},
  accessProvider: SessionResourceAccessProvider = createAccessProvider(),
) {
  const app = createApp({
    config,
    sessionHistoryRoutes: {
      provider: createHistoryProvider(overrides),
      accessProvider,
    },
  });
  return { app, accessProvider };
}

function createHistoryProvider(
  overrides: {
    readonly readEventAttachments?: SessionHistoryProvider["readEventAttachments"];
  } = {},
): SessionHistoryProvider {
  return {
    readViewport: async () => [],
    readMessages: async () => [[], null],
    readConversationContext: async () => null,
    readTimeline: async () => [[], null],
    readTimelineTrace: async () => null,
    readStory: async () => ({
      highlight: null,
      narrative: null,
      unfolded_turn_summaries: [],
      narrative_through_event_id: null,
      fold_count: 0,
      updated_at: null,
    }),
    readTurnSummaries: async () => ({
      session_id: "sess-1",
      mode: "count",
      total_count: 0,
      digested_count: 0,
      undigested_count: 0,
    }),
    readLastEventId: async () => 0,
    readEvent: async () => null,
    streamEventsRaw: () => ({
      async *[Symbol.asyncIterator]() {},
    }),
    ...overrides,
  } as SessionHistoryProvider;
}

function createAccessProvider(
  requireSessionAccess: SessionResourceAccessProvider["requireSessionAccess"] =
    vi.fn(async () => undefined),
): SessionResourceAccessProvider {
  return {
    requireSessionAccess: vi.fn(requireSessionAccess),
    requireFolderAccess: vi.fn(async () => undefined),
    resolveAccess: vi.fn(async () => ({ restricted: false, allowedFolderIds: [] })),
  };
}
