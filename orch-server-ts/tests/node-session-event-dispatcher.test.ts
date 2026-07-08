import { describe, expect, it } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  createNodeSessionEventBroadcasterSink,
  dispatchNodeRegistryEventsToSessionBroadcaster,
  type NodeRegistryEvent,
  type SessionStreamEvent,
} from "../src/index.js";

describe("node inbound session event dispatcher", () => {
  it("maps direct node session created, updated, and deleted events to session stream payloads", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "dispatcher-session-stream",
    });

    const result = dispatchNodeRegistryEventsToSessionBroadcaster(
      [
        {
          type: "node_session_session_created",
          nodeId: "node-1",
          data: {
            type: "session_created",
            agentSessionId: "sess-1",
            folder_id: "folder-1",
            session: {
              agentSessionId: "sess-1",
              title: "Created",
              agentId: "agent-a",
            },
          },
        },
        {
          type: "node_session_session_updated",
          nodeId: "node-1",
          data: {
            type: "session_updated",
            agentSessionId: "sess-1",
            status: "running",
          },
        },
        {
          type: "node_session_session_deleted",
          nodeId: "node-1",
          data: {
            type: "session_deleted",
            agentSessionId: "sess-1",
          },
        },
      ] satisfies NodeRegistryEvent[],
      broadcaster,
    );

    expect(result).toEqual({ appended: 3, skipped: 0, failed: 0 });
    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual([
      {
        type: "session_created",
        session: {
          agentSessionId: "sess-1",
          title: "Created",
          agentId: "agent-a",
          folder_id: "folder-1",
          folderId: "folder-1",
        },
        nodeId: "node-1",
        folder_id: "folder-1",
        folderId: "folder-1",
      },
      {
        type: "session_updated",
        agentSessionId: "sess-1",
        status: "running",
        agent_session_id: "sess-1",
        nodeId: "node-1",
      },
      {
        type: "session_deleted",
        agent_session_id: "sess-1",
      },
    ]);
  });

  it("maps runbook and custom view event envelopes while skipping non-session broadcasts", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "dispatcher-session-stream",
    });

    const result = dispatchNodeRegistryEventsToSessionBroadcaster(
      [
        {
          type: "node_session_event",
          nodeId: "node-1",
          data: {
            type: "event",
            agentSessionId: "sess-1",
            event: {
              type: "runbook_updated",
              runbookId: "rb-1",
              version: 2,
            },
          },
        },
        {
          type: "node_session_event",
          nodeId: "node-1",
          data: {
            type: "event",
            agentSessionId: "sess-1",
            event: {
              type: "custom_view_updated",
              customViewId: "cv-1",
            },
          },
        },
        {
          type: "node_session_sessions_update",
          nodeId: "node-1",
          data: { type: "sessions_update", sessions: [] },
        },
        {
          type: "ignored_stale_message",
          nodeId: "node-1",
          connectionId: "old",
          currentConnectionId: "new",
          messageType: "session_updated",
        },
        {
          type: "node_session_session_deleted",
          nodeId: "node-1",
          data: { type: "session_deleted" },
        },
      ] satisfies NodeRegistryEvent[],
      broadcaster,
    );

    expect(result).toEqual({ appended: 2, skipped: 3, failed: 0 });
    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual([
      {
        type: "runbook_updated",
        runbookId: "rb-1",
        version: 2,
        nodeId: "node-1",
      },
      {
        type: "custom_view_updated",
        customViewId: "cv-1",
        nodeId: "node-1",
      },
    ]);
  });

  it("offers a no-throw sink so broadcaster listener failures do not break the node route", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "dispatcher-session-stream",
    });
    broadcaster.subscribe(() => {
      throw new Error("listener failed");
    });
    const sink = createNodeSessionEventBroadcasterSink(broadcaster);

    expect(() =>
      sink([
        {
          type: "node_session_session_updated",
          nodeId: "node-1",
          data: {
            type: "session_updated",
            agentSessionId: "sess-1",
          },
        },
      ]),
    ).not.toThrow();
    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual([
      {
        type: "session_updated",
        agentSessionId: "sess-1",
        agent_session_id: "sess-1",
        nodeId: "node-1",
      },
    ]);
  });
});
