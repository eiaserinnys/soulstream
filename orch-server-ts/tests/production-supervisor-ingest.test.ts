import { describe, expect, it, vi } from "vitest";

import {
  createLiveProductionApplication,
  loadOrchServerEnvironment,
  type LiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/index.js";

type TestWebSocket = {
  send: (data: string) => void;
  terminate: () => void;
};

describe("production supervisor ingest wiring", () => {
  it("assembles the DB ingest sink and drains it before closing the shared SQL resolver", async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    let markAppendStarted: (() => void) | undefined;
    let releaseAppend: (() => void) | undefined;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      calls.push({ query, values });
      if (query.includes("supervisor_event_append")) {
        markAppendStarted?.();
        return appendReleased.then(() => [{
            offset: 1,
            inserted: true,
            contiguous_upto: 1,
            highest_seen_event_id: 1,
            gap_start: null,
            gap_end: null,
          }]);
      }
      return Promise.resolve([]);
    }) as LivePostgresSql;
    const sqlResolver: LiveDbSqlResolver = {
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(async () => undefined),
    };
    const application = await createLiveProductionApplication(
      loadOrchServerEnvironment(minimalEnvironment()),
      { warn: vi.fn() },
      { sqlResolver },
    );
    await application.app.ready();
    const ws = await (application.app as typeof application.app & {
      injectWS: (
        path: string,
        options: { headers: Record<string, string> },
      ) => Promise<TestWebSocket>;
    }).injectWS("/ws/node", {
      headers: { authorization: "Bearer production-service-token" },
    });

    ws.send(JSON.stringify({ type: "node_register", node_id: "node-a" }));
    ws.send(JSON.stringify({
      type: "event",
      agentSessionId: "session-a",
      event: { _event_id: 1, type: "assistant_message", content: "hello" },
    }));
    await appendStarted;

    ws.terminate();
    await application.app.close();
    let resourcesClosed = false;
    const closePromise = application.closeResources().then(() => {
      resourcesClosed = true;
    });
    await Promise.resolve();
    expect(resourcesClosed).toBe(false);
    expect(sqlResolver.close).not.toHaveBeenCalled();
    releaseAppend?.();
    await closePromise;

    expect(calls.find((call) => call.query.includes("supervisor_event_append"))?.values)
      .toEqual([
        "node-a",
        "session-a",
        1,
        "assistant_message",
        JSON.stringify({ _event_id: 1, type: "assistant_message", content: "hello" }),
        null,
      ]);
    expect(sqlResolver.close).toHaveBeenCalledTimes(1);
  });
});

function minimalEnvironment(): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    DATABASE_URL: "postgres://unused@localhost/unused",
    ENVIRONMENT: "production",
    CORS_ALLOWED_ORIGINS: "http://127.0.0.1",
    AUTH_BEARER_TOKEN: "production-service-token",
    BOARD_YJS_HOST_MODE: "orch",
    GOOGLE_CLIENT_ID: "dashboard-google-client",
    JWT_SECRET: "production-jwt-secret",
    CLAUDE_OAUTH_CLIENT_ID: "test-client",
    CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
  };
}
