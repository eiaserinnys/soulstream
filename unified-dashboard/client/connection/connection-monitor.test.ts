/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { createConnectionMonitor } from "./connection-monitor";
import {
  requestOrchestratorCheck,
  notifyOrchestratorShutdown,
  orchestratorFetch,
  registerConnectionRecovery,
  resynchronizeDashboard,
} from "@seosoyoung/soul-ui/lib/orchestrator-connection";

describe("connection owner", () => {
  it("leaves planner and session permission errors on their existing surfaces after recovery", async () => {
    const { createPlannerDataDependencies } =
      await import("../v3/planner-data");
    const { OrchestratorSessionProvider } =
      await import("../providers/OrchestratorSessionProvider");
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response("Forbidden", { status: 403 }),
      );
    const planner = createPlannerDataDependencies(globalThis.fetch);
    const provider = new OrchestratorSessionProvider();
    const disposePlanner = registerConnectionRecovery(async () => {
      await planner.fetchPlanner("/api/planner/today");
    });
    const disposeSessions = registerConnectionRecovery(async () => {
      await provider.fetchSessions();
    });
    try {
      await expect(resynchronizeDashboard()).resolves.toBeUndefined();
      await expect(
        planner.fetchPlanner("/api/planner/today"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(provider.fetchSessions()).rejects.toMatchObject({
        status: 403,
      });
      fetcher.mockImplementation(
        async () => new Response("Unavailable", { status: 503 }),
      );
      await expect(resynchronizeDashboard()).rejects.toThrow();
    } finally {
      disposePlanner();
      disposeSessions();
      fetcher.mockRestore();
    }
  });
  it("coalesces hints, polls only while disconnected and restores without reload", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const recover = vi.fn(async () => {}),
      reload = vi.fn(async () => true);
    const monitor = createConnectionMonitor({
      buildId: "a".repeat(40),
      fetch,
      recover,
      reload,
    });
    monitor.start();
    requestOrchestratorCheck();
    requestOrchestratorCheck();
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response("offline", { status: 503 }));
    await vi.waitFor(() =>
      expect(monitor.snapshot().phase).toBe("disconnected"),
    );
    const check = monitor.check();
    finish(
      new Response(
        JSON.stringify({
          healthy: true,
          ready: true,
          draining: false,
          build_id: "a".repeat(40),
        }),
      ),
    );
    await check;
    expect(recover).toHaveBeenCalledOnce();
    expect(monitor.snapshot().phase).toBe("connected");
    expect(reload).not.toHaveBeenCalled();
    monitor.stop();
  });
  it("keeps a shutdown notice blocking until health is ready", async () => {
    const monitor = createConnectionMonitor({
      buildId: "dev",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ healthy: false, draining: true, build_id: "dev" }),
          ),
      ),
      recover: async () => {},
      reload: async () => true,
    });
    monitor.start();
    notifyOrchestratorShutdown();
    await monitor.check();
    expect(monitor.snapshot().phase).toBe("planned");
    monitor.stop();
  });
  it("unblocks to the existing update banner when a new build reload is deferred", async () => {
    const reload = vi.fn(async () => false),
      recover = vi.fn(async () => {});
    const monitor = createConnectionMonitor({
      buildId: "a".repeat(40),
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              healthy: true,
              ready: true,
              draining: false,
              build_id: "b".repeat(40),
            }),
          ),
      ),
      recover,
      reload,
    });
    monitor.start();
    await monitor.check();
    expect(reload).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(monitor.snapshot().phase).toBe("connected");
    monitor.stop();
  });
  it("hints only network/gateway errors and preserves business responses", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 403 }));
    expect((await orchestratorFetch(fetch, "/api/cards")).status).toBe(403);
    fetch.mockImplementation(async () => {
      throw new TypeError("offline");
    });
    await expect(orchestratorFetch(fetch, "/api/cards")).rejects.toThrow(
      "offline",
    );
  });
});
