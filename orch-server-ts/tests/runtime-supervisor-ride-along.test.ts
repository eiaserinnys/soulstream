import { describe, expect, it, vi } from "vitest";

import {
  SupervisorIngestService,
  createOrchestratorRuntimeServices,
  parseOrchServerConfig,
  type SupervisorIngestRepository,
} from "../src/index.js";

describe("runtime supervisor ingest ride-along", () => {
  it("isolates DB failure without replacing canonical session sinks", async () => {
    const warning = vi.fn();
    const repository: SupervisorIngestRepository = {
      appendSupervisorEvent: vi.fn(async () => {
        throw new Error("fake DB unavailable");
      }),
      getSupervisorSourceCursor: vi.fn(async () => null),
      readEvents: vi.fn(async () => []),
    };
    const ingest = new SupervisorIngestService({ repository, onWarning: warning });
    const services = createOrchestratorRuntimeServices({
      config: parseOrchServerConfig({
        environment: "test",
        databaseUrl: "postgres://unused/unused",
        authBearerToken: "test-token",
      }),
      additionalNodeEventSinks: [(events) => ingest.accept(events)],
    });
    const events = [{
      type: "node_session_session_updated" as const,
      nodeId: "node-a",
      data: {
        agent_session_id: "session-a",
        last_event_id: 1,
        status: "completed",
      },
    }];

    expect(() => services.routeOptions.nodeWsRoute.eventSink?.(events)).not.toThrow();
    expect(services.sessionBroadcaster.bufferedEvents).toHaveLength(1);
    await ingest.flush();
    expect(warning).toHaveBeenCalledWith(
      "Supervisor event append failed for node-a/session-a/1",
      expect.any(Error),
    );
  });
});
