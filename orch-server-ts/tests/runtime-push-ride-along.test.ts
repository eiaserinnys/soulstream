import { describe, expect, it, vi } from "vitest";

import {
  createOrchestratorRuntimeServices,
  parseOrchServerConfig,
  type NodeRegistryEvent,
} from "../src/index.js";

describe("runtime push ride-along", () => {
  it("delivers node events to the additional sink without replacing canonical sinks", () => {
    const rideAlong = vi.fn();
    const services = createOrchestratorRuntimeServices({
      config: parseOrchServerConfig({
        environment: "test",
        databaseUrl: "postgres://unused/unused",
        authBearerToken: "test-token",
      }),
      additionalNodeEventSinks: [rideAlong],
    });
    const events: NodeRegistryEvent[] = [{
      type: "node_session_session_updated",
      nodeId: "node-a",
      data: { agent_session_id: "session-a", status: "completed" },
    }];

    expect(() => services.routeOptions.nodeWsRoute.eventSink?.(events)).not.toThrow();
    expect(rideAlong).toHaveBeenCalledWith(events);
    expect(services.sessionBroadcaster.bufferedEvents).toHaveLength(1);
  });
});
