import { describe, expect, it } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  dispatchNodeRegistryEventsToSessionBroadcaster,
  type NodeRegistryEvent,
  type SessionStreamEvent,
} from "../src/index.js";

describe("session feed fanout budget", () => {
  it("does not fan out a multi-session raw-event storm and shrinks frames/bytes", () => {
    const events: NodeRegistryEvent[] = [];
    const legacyExpandedFrames: Record<string, unknown>[] = [];
    for (let sessionIndex = 0; sessionIndex < 3; sessionIndex += 1) {
      const sessionId = `session-${sessionIndex}`;
      for (let eventIndex = 0; eventIndex < 40; eventIndex += 1) {
        events.push({
          type: "node_session_event",
          nodeId: "node-a",
          data: {
            type: "event",
            agentSessionId: sessionId,
            event: {
              type: "progress",
              text: `raw progress ${eventIndex}`,
              payload: "x".repeat(8 * 1024),
            },
          },
        });
        legacyExpandedFrames.push({
          type: "session_updated",
          agent_session_id: sessionId,
          status: "running",
          metadata: { raw: "x".repeat(8 * 1024) },
          prompt: "p".repeat(2 * 1024),
          last_event_id: eventIndex + 1,
        });
      }
      events.push({
        type: "node_session_session_updated",
        nodeId: "node-a",
        committedIngress: true,
        data: {
          type: "session_updated",
          agentSessionId: sessionId,
          last_message: {
            type: "assistant_message",
            eventId: 41,
            preview: `final ${sessionIndex}`,
            timestamp: "2026-09-06T12:00:00.000Z",
          },
          last_event_id: 41,
          metadata: { raw: "x".repeat(8 * 1024) },
          prompt: "p".repeat(2 * 1024),
        },
      });
    }
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "fanout-budget",
    });

    const result = dispatchNodeRegistryEventsToSessionBroadcaster(events, broadcaster);
    const frames = broadcaster.bufferedEvents.map(({ payload }) => payload);
    const afterBytes = frames.reduce((sum, frame) => sum + jsonBytes(frame), 0);
    const beforeBytes = legacyExpandedFrames.reduce(
      (sum, frame) => sum + jsonBytes(frame),
      0,
    );

    expect(result).toEqual({ appended: 3, skipped: 120, failed: 0 });
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.type === "session_updated")).toBe(true);
    expect(frames.map((frame) => frame.last_message)).toEqual([
      expect.objectContaining({ preview: "final 0" }),
      expect.objectContaining({ preview: "final 1" }),
      expect.objectContaining({ preview: "final 2" }),
    ]);
    expect(frames.every((frame) => !Object.hasOwn(frame, "metadata"))).toBe(true);
    expect(afterBytes).toBeLessThan(beforeBytes / 100);
  });
});

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
