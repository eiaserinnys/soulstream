import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeRuntimeHostClient } from "../src/control_plane/persistence_host_clients.js";

const orch = { baseUrl: "https://orch.example", headers: { authorization: "Bearer token" } };

const APPEND_INPUT = {
  idempotencyKey: "runner:append:batch-1",
  sessionId: "soul-session-a",
  key: { projectKey: "project-a", sessionId: "session-a" },
  entries: [{ type: "user", message: { content: "hello" } }] as never,
};

function clientFor(logger: Logger): ClaudeRuntimeHostClient {
  return new ClaudeRuntimeHostClient({ orch, logger });
}

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

function refusedConnection(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:3105"),
      { code: "ECONNREFUSED" },
    ),
  });
}

/** Drives the fake clock in one-second steps until the promise settles. */
async function driveUntilSettled(promise: Promise<unknown>, seconds: number): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  for (let second = 0; second < seconds && !settled; second += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(settled).toBe(true);
}

type FetchInit = RequestInit | undefined;

function requestBody(init: FetchInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function requestId(init: FetchInit): string {
  return new Headers(init?.headers).get("x-soulstream-persistence-request-id") ?? "";
}

describe("idempotent transcript append across an orchestrator restart", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries refused connections with the same idempotency key and stores once", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(refusedConnection())
      .mockRejectedValueOnce(refusedConnection())
      .mockRejectedValueOnce(refusedConnection())
      .mockResolvedValueOnce(new Response("2", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(silentLogger());

    const append = client.appendClaudeTranscriptEntriesIdempotent(APPEND_INPUT);
    await driveUntilSettled(append, 10);

    await expect(append).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const bodies = fetchMock.mock.calls.map(([, init]) => requestBody(init as FetchInit));
    expect(bodies.map(body => (body.args as Array<Record<string, unknown>>)[0]?.idempotency_key))
      .toEqual(Array(4).fill(APPEND_INPUT.idempotencyKey));
    // The entries subtree is opaque: snake_case conversion must not rewrite it.
    expect((bodies[3]?.args as Array<Record<string, unknown>>)[0]?.entries)
      .toEqual([{ type: "user", message: { content: "hello" } }]);
    // Only the per-request correlation id changes between attempts.
    const requestIds = fetchMock.mock.calls.map(([, init]) => requestId(init as FetchInit));
    expect(new Set(requestIds).size).toBe(4);
  });

  it("does not resend an append the host rejects as too large", async () => {
    const fetchMock = vi.fn(async () => new Response("too large", { status: 413 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(silentLogger());

    await expect(client.appendClaudeTranscriptEntriesIdempotent(APPEND_INPUT))
      .rejects.toMatchObject({
        name: "PersistenceHostRequestError",
        status: 413,
        retryable: false,
      });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up when the restart outlasts the 50s budget", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const attemptTimes: number[] = [];
    const fetchMock = vi.fn(async () => {
      attemptTimes.push(Date.now() - startedAt);
      throw refusedConnection();
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(silentLogger());

    const append = client.appendClaudeTranscriptEntriesIdempotent(APPEND_INPUT);
    const failure = append.catch((error: unknown) => error);
    await driveUntilSettled(failure, 60);

    await expect(failure).resolves.toMatchObject({ name: "PersistenceHostRequestError" });
    expect(attemptTimes.length).toBeGreaterThan(1);
    // The SDK abandons a store append after 60s, so every attempt must start
    // inside the 50s budget.
    expect(attemptTimes.at(-1)).toBeLessThan(50_000);
    expect(attemptTimes.every(attemptAtMs => attemptAtMs < 50_000)).toBe(true);
  });
});
