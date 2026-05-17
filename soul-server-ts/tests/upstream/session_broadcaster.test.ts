/**
 * SessionBroadcaster 단위 테스트 — Python `session_broadcaster.py` L67-108 wire 키 정합.
 */

import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import type { Task } from "../../src/task/task_models.js";

function makeRegistry() {
  return new AgentRegistry([
    {
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
      workspace_dir: "/tmp/codex-default",
      portrait_path: "/var/portraits/codex.png",
    },
  ]);
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-05-17T01:00:00Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    profileId: "codex-default",
    ...overrides,
  };
}

describe("emitSessionCreated", () => {
  it("Python wire 키 정합: type/session/folder_id/caller_source", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    const task = makeTask({
      callerInfo: { source: "slack", display_name: "주복" },
    });
    await b.emitSessionCreated(task, "folder-1");

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.type).toBe("session_created");
    expect(msg.folder_id).toBe("folder-1");
    expect(msg.caller_source).toBe("slack");
    expect(typeof msg.session).toBe("object");

    const session = msg.session as Record<string, unknown>;
    expect(session.agent_session_id).toBe("sess-1");
    expect(session.status).toBe("running");
    expect(session.node_id).toBe("eias-shopping-ts");
    expect(session.session_type).toBe("claude");
    expect(session.agentId).toBe("codex-default");
    expect(session.agentName).toBe("Codex Default");
    expect(session.agentPortraitUrl).toBe(
      "/api/agents/codex-default/portrait",
    );
    expect(session.backend).toBe("codex");
    expect(session.userName).toBe("주복");
    expect(session.caller_session_id).toBeNull();
    expect(session.last_event_id).toBe(0);
  });

  it("profileId 없으면 agentId/Name/PortraitUrl/backend 미포함", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    await b.emitSessionCreated(
      makeTask({ profileId: undefined }),
      null,
    );
    const session = (send.mock.calls[0][0] as Record<string, unknown>).session as Record<string, unknown>;
    expect(session.agentId).toBeUndefined();
    expect(session.backend).toBeUndefined();
  });

  it("caller_source 부재 시 null", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    await b.emitSessionCreated(makeTask(), null);
    expect((send.mock.calls[0][0] as Record<string, unknown>).caller_source).toBeNull();
  });
});

describe("emitSessionUpdated", () => {
  it("Python wire 키 정합 (12개 필드)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    const completedAt = new Date("2026-05-17T01:05:00Z");
    const task = makeTask({
      status: "completed",
      completedAt,
      lastEventId: 5,
      lastReadEventId: 3,
      lastProgressText: "step 1",
      lastAssistantText: "result text",
      callerInfo: {
        source: "agent",
        display_name: "서소영",
        avatar_url: "/u/seosoyoung.png",
      },
    });
    await b.emitSessionUpdated(task);

    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(msg).toMatchObject({
      type: "session_updated",
      agent_session_id: "sess-1",
      status: "completed",
      updated_at: completedAt.toISOString(),
      last_event_id: 5,
      last_read_event_id: 3,
      last_progress_text: "step 1",
      last_assistant_text: "result text",
      session_type: "claude",
      caller_source: "agent",
      userName: "서소영",
      userPortraitUrl: "/u/seosoyoung.png",
    });
  });

  it("completedAt 부재 시 now 사용", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    await b.emitSessionUpdated(makeTask());
    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof msg.updated_at).toBe("string");
    // valid ISO string
    expect(Number.isNaN(new Date(msg.updated_at as string).getTime())).toBe(false);
  });

  it("callerInfo 부재 시 null 필드", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    await b.emitSessionUpdated(makeTask());
    const msg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.caller_source).toBeNull();
    expect(msg.userName).toBeNull();
    expect(msg.userPortraitUrl).toBeNull();
    expect(msg.last_assistant_text).toBeNull();
    expect(msg.last_progress_text).toBeNull();
  });
});

describe("emitSessionDeleted", () => {
  it("agent_session_id 박힘", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    await b.emitSessionDeleted("sess-1");
    expect(send).toHaveBeenCalledWith({
      type: "session_deleted",
      agent_session_id: "sess-1",
    });
  });
});

describe("emitEventEnvelope", () => {
  it("agentSessionId camelCase + event 그대로 운반", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    const event = { type: "text_delta", text: "hi", timestamp: 1731700000 };
    // SSEEventPayload 타입 caster (open shape이라 unknown 캐스팅 필요)
    await b.emitEventEnvelope("sess-1", event as never);

    expect(send).toHaveBeenCalledWith({
      type: "event",
      agentSessionId: "sess-1",
      event,
    });
  });
});
