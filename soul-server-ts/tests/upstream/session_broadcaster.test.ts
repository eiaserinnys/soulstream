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
      metadata: [
        { type: "caller_info", value: { source: "slack", display_name: "주복" } },
      ],
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
    expect(session.metadata).toEqual([
      { type: "caller_info", value: { source: "slack", display_name: "주복" } },
    ]);
    expect(session.caller_session_id).toBeNull();
    expect(session.last_event_id).toBe(0);
  });

  it("profileId 없으면 agentId/Name/PortraitUrl은 null, backend는 'claude' default (X-2)", async () => {
    // Phase A backend 정본 단일화: profileId 부재 task도 wire backend default "claude"
    // (Python `_session_to_response`와 정합, atom d7a1ad86 정본 둘 안티패턴 차단)
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    await b.emitSessionCreated(
      makeTask({ profileId: undefined }),
      null,
    );
    const session = (send.mock.calls[0][0] as Record<string, unknown>).session as Record<string, unknown>;
    expect(session.agentId).toBeNull();
    expect(session.agentName).toBeNull();
    expect(session.agentPortraitUrl).toBeNull();
    expect(session.backend).toBe("claude");
  });

  it("profileId 있고 registry에 없을 때 backend 'claude' default (X-1)", async () => {
    // profile registry miss 시 agent?.backend ?? "claude" → "claude" (TS broadcaster
    // default 정책이 Python과 정합)
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    await b.emitSessionCreated(
      makeTask({ profileId: "unknown-profile" }),
      null,
    );
    const session = (send.mock.calls[0][0] as Record<string, unknown>).session as Record<string, unknown>;
    expect(session.agentId).toBe("unknown-profile");
    expect(session.agentName).toBeNull();
    expect(session.backend).toBe("claude");
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

describe("emitSessionMessageUpdated (F-3A)", () => {
  it("Python wire 키 7종 정확 (last_message 식별 마커 + caller_source/userName/userPortraitUrl 부재)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "eias-shopping-ts");
    const lastMessage = {
      type: "text_delta",
      preview: "hello world",
      timestamp: "2026-05-17T01:02:03.000Z",
    };
    await b.emitSessionMessageUpdated(
      "sess-1",
      "running",
      "2026-05-17T01:02:03.000Z",
      lastMessage,
      7,
      3,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as Record<string, unknown>;

    // 정확히 7개 키
    expect(Object.keys(msg).sort()).toEqual(
      [
        "agent_session_id",
        "last_event_id",
        "last_message",
        "last_read_event_id",
        "status",
        "type",
        "updated_at",
      ].sort(),
    );

    expect(msg).toEqual({
      type: "session_updated",
      agent_session_id: "sess-1",
      status: "running",
      updated_at: "2026-05-17T01:02:03.000Z",
      last_message: lastMessage,
      last_event_id: 7,
      last_read_event_id: 3,
    });

    // P6 결정: emit_session_updated/phase와 달리 user 프로필·caller_source는 *비움*
    expect(msg.caller_source).toBeUndefined();
    expect(msg.userName).toBeUndefined();
    expect(msg.userPortraitUrl).toBeUndefined();
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

describe("SessionBroadcaster.emitInterventionSent (B-4)", () => {
  it("intervention_sent wire envelope 정합 — Python InterventionSentEvent 정본", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "node-A");
    await b.emitInterventionSent("sess-1", {
      text: "hi",
      user: "alice",
      callerInfo: { source: "slack", display_name: "Alice" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.type).toBe("event");
    expect(payload.agentSessionId).toBe("sess-1");
    const event = payload.event as Record<string, unknown>;
    expect(event.type).toBe("intervention_sent");
    expect(event.user).toBe("alice");
    expect(event.text).toBe("hi");
    expect(event.caller_info).toEqual({ source: "slack", display_name: "Alice" });
    expect(typeof event.timestamp).toBe("number");
  });

  it("callerInfo·attachmentPaths 미전달 시 envelope에서 키 자체 생략", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "node-A");
    await b.emitInterventionSent("sess-1", { text: "hi", user: "u" });
    const event = (send.mock.calls[0][0] as { event: Record<string, unknown> }).event;
    expect(event.caller_info).toBeUndefined();
    expect(event.attachments).toBeUndefined();
  });

  it("attachmentPaths 비어있지 않으면 attachments 키로 발행", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "node-A");
    await b.emitInterventionSent("sess-1", {
      text: "see image",
      user: "u",
      attachmentPaths: ["/tmp/a.png", "/tmp/b.png"],
    });
    const event = (send.mock.calls[0][0] as { event: Record<string, unknown> }).event;
    expect(event.attachments).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  });
});

describe("SessionBroadcaster.emitCatalogUpdated (B-5)", () => {
  it("catalog_updated wire envelope 정합 (Python `task_manager.py:312-316` 정본)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = new SessionBroadcaster(send, makeRegistry(), "node-A");
    const catalog = {
      folders: [{ id: "f1", name: "F1", sortOrder: 0, settings: {} }],
      sessions: { "s1": { folderId: "f1", displayName: null } },
    };
    await b.emitCatalogUpdated(catalog);
    expect(send).toHaveBeenCalledWith({
      type: "catalog_updated",
      catalog,
    });
  });
});
