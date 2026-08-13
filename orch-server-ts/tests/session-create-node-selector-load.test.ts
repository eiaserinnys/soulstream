import { describe, expect, it } from "vitest";

import { InMemoryNodeRegistry } from "../src/node/registry.js";
import {
  selectNodeForSessionCreate,
  SessionCreateNodeSelectionError,
} from "../src/session/session_create_node_selector.js";

describe("session create node load selection", () => {
  it("selects the node with fewer running sessions even when its cumulative session count is larger", () => {
    const registry = registryWithNodes([
      { nodeId: "node-history-heavy", maxConcurrent: 8 },
      { nodeId: "node-history-light", maxConcurrent: 8 },
    ]);
    seedHistoricalSessions(registry, "node-history-heavy", 100);
    seedHistoricalSessions(registry, "node-history-light", 1);
    reportRunningSessions(registry, "node-history-heavy", 1);
    reportRunningSessions(registry, "node-history-light", 2);

    expect(selectNodeForSessionCreate(registry, { profileId: "roselin" }).node.nodeId)
      .toBe("node-history-heavy");
  });

  it("ignores the transient cache inflation immediately after a node reconnect seed", () => {
    const registry = registryWithNodes([
      { nodeId: "node-just-reconnected", maxConcurrent: 8 },
      { nodeId: "node-past-terminal-sweep", maxConcurrent: 8 },
    ]);
    seedHistoricalSessions(registry, "node-just-reconnected", 5_032);
    seedHistoricalSessions(registry, "node-past-terminal-sweep", 52);
    reportRunningSessions(registry, "node-just-reconnected", 1);
    reportRunningSessions(registry, "node-past-terminal-sweep", 2);

    expect(selectNodeForSessionCreate(registry, { profileId: "roselin" }).node.nodeId)
      .toBe("node-just-reconnected");
  });

  it("compares running occupancy against each node's advertised capacity", () => {
    const registry = registryWithNodes([
      { nodeId: "node-capacity-7", maxConcurrent: 7 },
      { nodeId: "node-capacity-8", maxConcurrent: 8 },
    ]);
    reportRunningSessions(registry, "node-capacity-7", 6);
    reportRunningSessions(registry, "node-capacity-8", 6);

    expect(selectNodeForSessionCreate(registry, { profileId: "roselin" }).node.nodeId)
      .toBe("node-capacity-8");
  });

  it("does not treat a node without runner inventory as idle", () => {
    const registry = registryWithNodes([
      { nodeId: "node-unknown", maxConcurrent: 8 },
      { nodeId: "node-reported", maxConcurrent: 8 },
    ]);
    reportRunningSessions(registry, "node-reported", 7);

    expect(selectNodeForSessionCreate(registry, { profileId: "roselin" }).node.nodeId)
      .toBe("node-reported");
  });

  it("fails automatic selection when every compatible node has unknown load", () => {
    const registry = registryWithNodes([
      { nodeId: "node-a", maxConcurrent: 7 },
      { nodeId: "node-b", maxConcurrent: 8 },
    ]);

    expect(() => selectNodeForSessionCreate(registry, { profileId: "roselin" }))
      .toThrowError(expect.objectContaining<Partial<SessionCreateNodeSelectionError>>({
        code: "NO_AVAILABLE_NODE",
        statusCode: 503,
      }));
  });

  it("accepts legacy sessions_update inventory during a rolling deployment", () => {
    const registry = registryWithNodes([
      { nodeId: "node-legacy", maxConcurrent: 7, runnerInventoryV1: false },
    ]);
    registry.receiveNodeMessage("node-legacy", {
      type: "sessions_update",
      sessions: [],
      running_session_ids: ["legacy-running"],
    });

    expect(registry.getReportedRunnerLoad("node-legacy")).toEqual({
      runningSessionCount: 1,
      maxConcurrent: 7,
    });
  });

  it("keeps reported load current from lifecycle events and resets it on reconnect", () => {
    const registry = registryWithNodes([
      { nodeId: "node-a", maxConcurrent: 8 },
    ]);
    reportRunningSessions(registry, "node-a", 1);
    registry.receiveNodeMessage("node-a", {
      type: "session_created",
      agentSessionId: "session-new",
      status: "running",
    });
    expect(registry.getReportedRunnerLoad("node-a")?.runningSessionCount).toBe(2);

    registry.receiveNodeMessage("node-a", {
      type: "session_updated",
      agentSessionId: "node-a-running-0",
      status: "completed",
    });
    registry.receiveNodeMessage("node-a", {
      type: "session_deleted",
      agentSessionId: "session-new",
    });
    expect(registry.getReportedRunnerLoad("node-a")?.runningSessionCount).toBe(0);

    registerNode(registry, {
      nodeId: "node-a",
      maxConcurrent: 8,
      runnerInventoryV1: true,
    });
    expect(registry.getReportedRunnerLoad("node-a")).toBeUndefined();
  });
});

function registryWithNodes(
  nodes: Array<{
    nodeId: string;
    maxConcurrent: number;
    runnerInventoryV1?: boolean;
  }>,
): InMemoryNodeRegistry {
  const registry = new InMemoryNodeRegistry();
  for (const node of nodes) {
    registerNode(registry, {
      ...node,
      runnerInventoryV1: node.runnerInventoryV1 ?? true,
    });
  }
  return registry;
}

function registerNode(
  registry: InMemoryNodeRegistry,
  node: {
    nodeId: string;
    maxConcurrent: number;
    runnerInventoryV1: boolean;
  },
): void {
  registry.registerNode({
    type: "node_register",
    node_id: node.nodeId,
    agents: [{ id: "roselin", backend: "codex" }],
    capabilities: {
      max_concurrent: node.maxConcurrent,
      runner_inventory_v1: node.runnerInventoryV1,
    },
    supported_backends: ["codex"],
  });
}

function seedHistoricalSessions(
  registry: InMemoryNodeRegistry,
  nodeId: string,
  count: number,
): void {
  const connectionId = registry.getConnectedNode(nodeId)?.connectionId;
  if (!connectionId) throw new Error(`node is not connected: ${nodeId}`);
  registry.sessionCache.replaceNodeSessions({
    nodeId,
    connectionId,
    sessions: Array.from({ length: count }, (_, index) => ({
      agentSessionId: `${nodeId}-historical-${index}`,
      status: "completed",
    })),
    nowMs: 1_700_000_000_000,
  });
}

function reportRunningSessions(
  registry: InMemoryNodeRegistry,
  nodeId: string,
  count: number,
): void {
  registry.receiveNodeMessage(nodeId, {
    type: "runner_inventory",
    running_session_ids: Array.from(
      { length: count },
      (_, index) => `${nodeId}-running-${index}`,
    ),
  });
}
