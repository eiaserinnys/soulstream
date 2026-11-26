import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionDataHostClient } from "../src/control_plane/session_data_host_client.js";

interface LogEntry {
  level: "warn" | "info";
  fields: Record<string, unknown>;
  message: string;
}

function recordingLogger(): { logger: Logger; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const record = (level: "warn" | "info") => (fields: unknown, message?: string) => {
    logs.push({
      level,
      fields: (fields ?? {}) as Record<string, unknown>,
      message: message ?? "",
    });
  };
  const logger = {
    warn: record("warn"),
    info: record("info"),
    error: record("warn"),
    debug: () => undefined,
  } as unknown as Logger;
  return { logger, logs };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(logger: Logger): SessionDataHostClient {
  return new SessionDataHostClient({
    orch: { baseUrl: "http://orchestrator.test", headers: {} },
    logger,
  });
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

function retryLogs(logs: LogEntry[]): LogEntry[] {
  return logs.filter(
    entry => entry.level === "warn" && entry.message.includes("retrying"),
  );
}

function recoveredLogs(logs: LogEntry[]): LogEntry[] {
  return logs.filter(
    entry => entry.level === "info" && entry.message.includes("recovered"),
  );
}

describe("input-preparation reads across an orchestrator restart", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "generation checkpoint material",
      readName: "generation_checkpoint",
      result: {},
      read: (client: SessionDataHostClient) =>
        client.getGenerationCheckpointMaterial("s1", {
          recentEventLimit: 20,
          unsummarizedEventLimit: 200,
        }),
    },
    {
      label: "a session event page",
      readName: "session_events",
      result: [],
      read: (client: SessionDataHostClient) => client.readEvents("s1", 0, 10),
    },
    {
      label: "the session story",
      readName: "session_story",
      result: { narrative: null, unfolded_turn_summaries: [] },
      read: (client: SessionDataHostClient) => client.getSessionStory("s1"),
    },
  ])("keeps $label through a restart window", async ({ readName, result, read }) => {
    vi.useFakeTimers();
    const { logger, logs } = recordingLogger();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(refusedConnection())
      .mockRejectedValueOnce(refusedConnection())
      .mockResolvedValueOnce(jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(logger);

    const request = read(client);
    await driveUntilSettled(request, 10);

    await expect(request).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retryLogs(logs).map(entry => entry.fields.read)).toEqual([readName, readName]);
    expect(recoveredLogs(logs)[0]?.fields).toMatchObject({ read: readName, attempt: 3 });
  });

  it("still fails a rejected read immediately", async () => {
    const { logger, logs } = recordingLogger();
    const fetchMock = vi.fn(async () => jsonResponse(
      { detail: { error: { code: "REJECTED", message: "no" } } },
      400,
    ));
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(logger);

    await expect(client.readEvents("s1", 0, 10))
      .rejects.toMatchObject({ name: "SessionDataHostError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retryLogs(logs)).toEqual([]);
  });
});
