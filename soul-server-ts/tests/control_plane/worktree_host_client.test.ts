import pino, { type Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PersistenceHostRequestError } from "../../src/control_plane/persistence_host_transport.js";
import { WorktreeHostClient } from "../../src/control_plane/worktree_host_client.js";

const logger = pino({ level: "silent" });

interface LogEntry {
  level: "warn" | "info";
  fields: Record<string, unknown>;
  message: string;
}

/** Captures the client's own retry/recovery lines. */
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

const registerInput = {
  actorSessionId: "s1",
  id: "wt",
  nodeId: "n1",
  repoId: "demo",
  canonicalPath: "/projects/demo--feature",
  branch: "feature",
  createdFromSha: "a".repeat(40),
  setupMode: "none" as const,
  setupRequired: false,
  setupStatus: "not_requested" as const,
  managedPaths: [],
  worktreeIdentity: "wt",
};

describe("WorktreeHostClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gives the inventory read three 5000ms attempts with backoff", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "busy" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "busy" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "wt" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorktreeHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });

    const startedAt = Date.now();
    await expect(client.list({ actorSessionId: "s1", nodeId: "n1" })).resolves.toEqual([{ id: "wt" }]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([5_000, 5_000, 5_000]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_200);
  });

  it("outlasts an orchestrator restart for the isolation inventory read", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { logger: log, logs } = recordingLogger();
    const startedAt = Date.now();
    const fetchMock = vi.fn(async () => {
      if (Date.now() - startedAt < 20_000) {
        return new Response(JSON.stringify({ message: "bad gateway" }), { status: 502 });
      }
      return new Response(JSON.stringify([{ id: "wt" }]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorktreeHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger: log,
    });

    const request = client.list(
      { actorSessionId: "s1", nodeId: "n1" },
      { restartWindow: true },
    );
    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    for (let second = 0; second < 40 && !settled; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(request).resolves.toEqual([{ id: "wt" }]);
    expect(settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(9);
    // The restart window replaces the plain 5s attempt timeout with 8s.
    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs))
      .toEqual(Array(9).fill(8_000));
    const retries = logs.filter(
      entry => entry.level === "warn" && entry.message.includes("retrying"),
    );
    expect(retries.map(entry => entry.fields.read))
      .toEqual(Array(8).fill("isolation_worktree_list"));
    expect(retries.map(entry => entry.fields.retryInMs))
      .toEqual([250, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
    const recovered = logs.find(
      entry => entry.level === "info" && entry.message.includes("recovered"),
    );
    expect(recovered?.fields).toMatchObject({
      read: "isolation_worktree_list",
      attempt: 9,
      elapsedMs: 23_250,
    });
  });

  it("does not retry an inventory read the host rejects as invalid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "bad request" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorktreeHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });

    await expect(client.list({ actorSessionId: "s1", nodeId: "n1" }))
      .rejects.toBeInstanceOf(PersistenceHostRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps mutating worktree calls single-attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "busy" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorktreeHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });

    await expect(client.register(registerInput)).rejects.toBeInstanceOf(PersistenceHostRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
