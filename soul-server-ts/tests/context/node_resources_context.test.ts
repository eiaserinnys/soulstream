import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchNodeResourcesContextItem,
  formatNodeResourcesContext,
} from "../../src/context/node_resources_context.js";
import type { NodeResourceSnapshot } from "@soulstream/wire-schema/node-resources";

const originalFetch = globalThis.fetch;
const silentLogger = pino({ level: "silent" });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const resources: NodeResourceSnapshot = {
  collectedAt: "2026-10-22T03:00:00.000Z",
  cpu: { usagePercent: 12.5, cores: 4, loadAvg1m: 0.25 },
  memory: {
    usagePercent: 50,
    usedBytes: 1024 ** 3,
    availableBytes: 1024 ** 3,
    totalBytes: 2 * 1024 ** 3,
  },
  disk: {
    path: "/work",
    usagePercent: 75,
    usedBytes: 3 * 1024 ** 3,
    availableBytes: 1024 ** 3,
    totalBytes: 4 * 1024 ** 3,
  },
  diskQueue: { device: "sda", inFlight: 1, avgQueueDepth: 0.4, busyPercent: 2.5 },
};

describe("node resources context", () => {
  it("formats measured and not-yet-measured nodes", () => {
    const text = formatNodeResourcesContext([
      { nodeId: "node-a", status: "connected", resources },
      { nodeId: "node-b", status: "disconnected" },
    ]);

    expect(text).toContain("노드 자원 상태 (2개 노드)");
    expect(text).toContain("- node-a [connected, 측정 2026-10-22T03:00:00.000Z]: CPU 12.5% (4c, load 0.25)");
    expect(text).toContain("RAM 50.0% (1.00/2.00 GiB, 가용 1.00 GiB)");
    expect(text).toContain("DISK 75.0%");
    expect(text).toContain("DISK queue sda");
    expect(text).toContain("- node-b [disconnected]: 자원 측정 대기 중");
    expect(formatNodeResourcesContext([])).toBe("노드 자원 상태 (연결된 노드 없음)");
  });

  it("requests all nodes with the configured authorization headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [{ nodeId: "node-a", status: "connected", resources }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const item = await fetchNodeResourcesContextItem({
      baseUrl: "https://orch.test",
      headers: { authorization: "Bearer test-token" },
      timeoutMs: 50,
    }, silentLogger);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://orch.test/api/nodes?includeDisconnected=true",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer test-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(item).toMatchObject({ key: "node_resources", label: "노드 자원 상태" });
    expect(String(item.content)).toContain("node-a");
  });

  it("returns the unavailable status when the orchestrator request fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

    await expect(fetchNodeResourcesContextItem({
      baseUrl: "https://orch.test",
      headers: {},
    }, silentLogger)).resolves.toEqual({
      key: "node_resources",
      label: "노드 자원 상태",
      content: "노드 자원 상태 조회 불가 (오케스트레이터 응답 없음)",
    });
  });
});
