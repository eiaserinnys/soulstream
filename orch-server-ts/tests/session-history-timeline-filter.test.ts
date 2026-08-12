import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  type SessionHistoryProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function createHarness() {
  const readTimeline = vi.fn(async () => [[], null] as [unknown[], string | null]);
  const provider = { readTimeline } as unknown as SessionHistoryProvider;
  const app = createApp({
    config,
    sessionHistoryRoutes: { provider, closeAfterHistorySync: true },
  });
  return { app, readTimeline };
}

describe("session timeline event_types filter", () => {
  it("passes an additive event_types subset to timeline reads", async () => {
    const { app, readTimeline } = createHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?event_types=user_message,assistant_message",
    });

    expect(response.statusCode).toBe(200);
    expect(readTimeline).toHaveBeenCalledWith(
      "sess-1",
      null,
      50,
      ["user_message", "assistant_message"],
    );
    await app.close();
  });

  it("rejects empty and unknown event_types before provider access", async () => {
    const { app, readTimeline } = createHarness();

    for (const query of ["event_types=", "event_types=user_message,future_event"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/sess-1/timeline?${query}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_QUERY", details: { field: "event_types" } },
      });
    }
    expect(readTimeline).not.toHaveBeenCalled();
    await app.close();
  });
});
