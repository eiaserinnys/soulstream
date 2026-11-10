import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PersistenceHostRequestError } from "../../src/control_plane/persistence_host_transport.js";
import { WorktreeHostClient } from "../../src/control_plane/worktree_host_client.js";

const logger = pino({ level: "silent" });

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
