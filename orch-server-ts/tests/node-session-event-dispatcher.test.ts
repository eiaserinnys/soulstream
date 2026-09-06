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
              review_required: true,
              review_state: "not_required",
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
            review_required: true,
            review_state: "needs_review",
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
    const payloads = broadcaster.bufferedEvents.map((event) => event.payload);
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toMatchObject({
        type: "session_created",
        session: {
          agentSessionId: "sess-1",
          agentId: "agent-a",
          folderId: "folder-1",
          reviewRequired: true,
          reviewState: "not_required",
        },
        nodeId: "node-1",
        folder_id: "folder-1",
        folderId: "folder-1",
      });
    expect(payloads[1]).toMatchObject({
        type: "session_updated",
        status: "running",
        agent_session_id: "sess-1",
        review_required: true,
        review_state: "needs_review",
      });
    expect(payloads[2]).toEqual({
        type: "session_deleted",
        agent_session_id: "sess-1",
      });
  });

  it("maps task and custom view event envelopes while skipping non-session broadcasts", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "dispatcher-session-stream",
    });

    const result = dispatchNodeRegistryEventsToSessionBroadcaster(
      [
        {
          type: "node_session_event",
          nodeId: "node-1",
          data: {
            type: "catalog_updated",
            catalog: {
              folders: [{ id: "folder-1" }],
              sessions: [{ agentSessionId: "sess-1", folderId: "folder-1" }],
            },
          },
        },
        {
          type: "node_session_event",
          nodeId: "node-1",
          data: {
            type: "catalog_updated",
            folders: [{ id: "folder-2" }],
            sessions_delta: {
              "sess-2": { folderId: "folder-2", displayName: "Renamed" },
            },
            board_items_delta: {},
          },
        },
        {
          type: "node_session_event",
          nodeId: "node-1",
          data: {
            type: "event",
            agentSessionId: "sess-1",
            event: {
              type: "task_updated",
              taskId: "rb-1",
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

    expect(result).toEqual({ appended: 4, skipped: 3, failed: 0 });
    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual([
      {
        type: "catalog_updated",
        catalog: {
          folders: [{ id: "folder-1" }],
          sessions: [{ agentSessionId: "sess-1", folderId: "folder-1" }],
        },
        nodeId: "node-1",
      },
      {
        type: "catalog_updated",
        folders: [{ id: "folder-2" }],
        sessions_delta: {
          "sess-2": { folderId: "folder-2", displayName: "Renamed" },
        },
        board_items_delta: {},
        nodeId: "node-1",
      },
      {
        type: "task_updated",
        taskId: "rb-1",
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

  it("keeps durable feed projections behind the committed-ingress marker", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "dispatcher-feed-trust",
    });
    const spoofedFeed = {
      lastMessage: {
        type: "assistant_message",
        preview: "spoofed",
        timestamp: "2026-09-07T00:00:00.000Z",
      },
      pendingAttentions: [{ id: "spoofed-attention" }],
      attentionRevision: 99,
      recentNotices: [{ id: "spoofed-notice" }],
      notificationWatermark: 99,
      noticesTruncated: true,
    };

    dispatchNodeRegistryEventsToSessionBroadcaster([
      {
        type: "node_session_session_created",
        nodeId: "node-1",
        data: {
          type: "session_created",
          agentSessionId: "sess-untrusted",
          session: { agentSessionId: "sess-untrusted", ...spoofedFeed },
        },
      },
      {
        type: "node_session_session_updated",
        nodeId: "node-1",
        data: {
          type: "session_updated",
          agentSessionId: "sess-untrusted",
          last_message: spoofedFeed.lastMessage,
          attention_revision: 99,
          pending_attentions_delta: { spoofed: null },
          notices: [{ id: "spoofed-notice" }],
          notification_watermark: 99,
        },
      },
      {
        type: "node_session_session_updated",
        nodeId: "node-1",
        committedIngress: true,
        data: {
          type: "session_updated",
          agentSessionId: "sess-committed",
          last_message: spoofedFeed.lastMessage,
          attention_revision: 7,
          pending_attentions_delta: { committed: null },
          notices: [{ id: "committed-notice" }],
          notification_watermark: 7,
        },
      },
    ] satisfies NodeRegistryEvent[], broadcaster);

    const payloads = broadcaster.bufferedEvents.map((event) => event.payload);
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toMatchObject({
        type: "session_created",
        session: {
          agentSessionId: "sess-untrusted",
          lastMessage: null,
          pendingAttentions: [],
          attentionRevision: 0,
          recentNotices: [],
          notificationWatermark: 0,
          noticesTruncated: false,
        },
        nodeId: "node-1",
      });
    expect(payloads[1]).toEqual({
        type: "session_updated",
        agent_session_id: "sess-untrusted",
      });
    expect(payloads[2]).toEqual({
        type: "session_updated",
        agent_session_id: "sess-committed",
        last_message: spoofedFeed.lastMessage,
        attention_revision: 7,
        pending_attentions_delta: { committed: null },
        notices: [{ id: "committed-notice" }],
        notification_watermark: 7,
      });
  });

  it("normalizes a production-gated runbook_updated event at the ingestion boundary", () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "dispatcher-session-stream",
    });

    const result = dispatchNodeRegistryEventsToSessionBroadcaster(
      [
        {
          type: "node_session_event",
          nodeId: "node-legacy",
          data: {
            type: "event",
            agentSessionId: "sess-legacy",
            event: {
              type: "runbook_updated",
              runbookId: "rb-legacy",
              boardItemId: "runbook:opaque-id",
            },
          },
        },
      ] satisfies NodeRegistryEvent[],
      broadcaster,
    );

    expect(result).toEqual({ appended: 1, skipped: 0, failed: 0 });
    expect(broadcaster.bufferedEvents[0]?.payload).toEqual({
      type: "task_updated",
      taskId: "rb-legacy",
      boardItemId: "runbook:opaque-id",
      nodeId: "node-legacy",
    });
    expect(broadcaster.bufferedEvents[0]?.payload).not.toHaveProperty("runbookId");
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
      expect.objectContaining({
        type: "session_updated",
        agent_session_id: "sess-1",
      }),
    ]);
  });
});
