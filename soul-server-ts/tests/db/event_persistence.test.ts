import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_DURABILITY } from "@soulstream/wire-schema";

import {
  EventPersistence,
  extractSearchableText,
  isLiveOnlyEvent,
  sanitizeJsonText,
  sanitizeJsonValue,
  shouldPersistEvent,
} from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import type { Task } from "../../src/task/task_models.js";
import type { EventOutboxRecord } from "../../src/upstream/event_outbox.js";
import type { EventOutboxPump } from "../../src/upstream/event_outbox_pump.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const SECTION_7_TRANSIENT_STREAMING_TYPES = [
  "text_start",
  "text_delta",
  "text_end",
] as const;

const SECTION_7_DURABLE_ENGINE_DOMAIN_TYPES = [
  "progress",
  "session",
  "intervention_sent",
  "session_notification",
  "user_message",
  "assistant_message",
  "input_request",
  "input_request_expired",
  "input_request_responded",
  "debug",
  "complete",
  "error",
  "credential_alert",
  "session_ended",
  "thinking",
  "tool_start",
  "tool_result",
  "agent_updated",
  "handoff_requested",
  "handoff_occurred",
  "tool_approval_requested",
  "tool_approval_resolved",
  "guardrail_tripwire",
  "realtime_status",
  "realtime_transcript",
  "result",
  "prompt_suggestion",
  "subagent_start",
  "subagent_stop",
  "claude_runtime_session_state",
  "claude_runtime_task_started",
  "claude_runtime_task_created",
  "claude_runtime_task_updated",
  "claude_runtime_task_progress",
  "claude_runtime_task_completed",
  "claude_runtime_task_notification",
  "claude_runtime_notification",
  "claude_runtime_remote_trigger",
  "claude_runtime_transcript_mirror_error",
  "claude_runtime_hook_event",
  "claude_runtime_mode_state",
  "claude_runtime_schedule_updated",
  "claude_runtime_schedule_deleted",
  "context_usage",
  "context_manifest",
  "compact",
  "assistant_error",
  "away_summary",
] as const;

const SECTION_7_ORCH_DERIVED_DURABLE_TYPES = ["turn_summary"] as const;
const SECTION_7_SSE_CONTROL_TYPES = ["init", "history_sync"] as const;
const SECTION_7_STATE_NOTIFICATION_TYPES = [
  "task_updated",
  "custom_view_updated",
] as const;
const SECTION_7_RESERVED_TYPES = [
  "reconnected",
  "memory",
  "runbook_updated",
  "reconnect",
  "metadata_updated",
] as const;

const SECTION_7_ALL_EVENT_TYPES = [
  ...SECTION_7_TRANSIENT_STREAMING_TYPES,
  ...SECTION_7_DURABLE_ENGINE_DOMAIN_TYPES,
  ...SECTION_7_ORCH_DERIVED_DURABLE_TYPES,
  ...SECTION_7_SSE_CONTROL_TYPES,
  ...SECTION_7_STATE_NOTIFICATION_TYPES,
  ...SECTION_7_RESERVED_TYPES,
] as const;

const PERSISTENCE_ONLY_EVENT_TYPES = ["metadata", "system_message"] as const;
const ALL_PERSISTENCE_EVENT_TYPES = [
  ...SECTION_7_ALL_EVENT_TYPES,
  ...PERSISTENCE_ONLY_EVENT_TYPES,
] as const;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    ...overrides,
  };
}

function makeMockDB() {
  const appendEvent = vi.fn().mockResolvedValue(42);
  const findEventIdByDedupeKey = vi.fn().mockResolvedValue(null);
  const updateLastMessage = vi.fn().mockResolvedValue(undefined);
  return {
    db: { appendEvent, findEventIdByDedupeKey, updateLastMessage } as unknown as SessionDB,
    appendEvent,
    findEventIdByDedupeKey,
    updateLastMessage,
  };
}

function makeMockBroadcaster() {
  const emitSessionMessageUpdated = vi.fn().mockResolvedValue(undefined);
  return {
    broadcaster: { emitSessionMessageUpdated } as unknown as SessionBroadcaster,
    emitSessionMessageUpdated,
  };
}

function makeMockIngress() {
  const record: EventOutboxRecord = {
    stream_id: "stream-1",
    source_seq: 7,
    session_id: "sess-1",
    event_type: "assistant_message",
    payload: { type: "assistant_message", content: "hi" },
    searchable_text: "hi",
    created_at: "2024-11-15T22:26:40.000Z",
    semantic_dedupe_key: null,
    session_effect: null,
    payload_hash: "a".repeat(64),
  };
  const append = vi.fn().mockResolvedValue(record);
  const waitForAcknowledgement = vi.fn().mockResolvedValue(42);
  const waitForAcknowledgementResult = vi.fn().mockResolvedValue({
    source_seq: 7,
    event_id: 42,
    effect_application: {
      applied: true,
      canonical_session: {
        status: "running",
        termination_reason: null,
        termination_detail: null,
        review_state: "not_required",
        last_assistant_text: null,
        termination_event_id: null,
        updated_at: "2026-08-11T00:00:00.000Z",
        last_event_id: 42,
      },
    },
  });
  return {
    outbox: { append },
    pump: {
      waitForAcknowledgement,
      waitForAcknowledgementResult,
    } as unknown as EventOutboxPump,
    append,
    waitForAcknowledgement,
    waitForAcknowledgementResult,
    record,
  };
}

function makeEventPersistence(db: SessionDB, broadcaster: SessionBroadcaster) {
  const ingress = makeMockIngress();
  return new EventPersistence(
    db,
    broadcaster,
    silentLogger,
    ingress.outbox,
    ingress.pump,
  );
}

const silentLogger = pino({ level: "silent" });

describe("sanitizeJsonText", () => {
  it("removes NUL, replaces lone surrogates, and preserves valid pairs", () => {
    expect(sanitizeJsonText("a\u0000b\ud800c\udfff😀")).toBe("ab�c�😀");
  });

  it("removes undefined object fields and normalizes undefined array slots", () => {
    expect(sanitizeJsonValue({
      kept: "value",
      missing: undefined,
      nested: { missing: undefined },
      values: [undefined, { missing: undefined }],
    })).toEqual({
      kept: "value",
      nested: {},
      values: [null, {}],
    });
  });
});

describe("EventPersistence durable ingress", () => {
  it("maps runner snapshot correlation to semantic dedupe without leaking it into payload", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await ep.enqueueMetadataEffect("sess-1", {
      type: "agents_run_state",
      value: { serialized: "state" },
    }, {
      replaceExistingType: "agents_run_state",
      semanticDedupeKey: "runner:snapshot:1",
    });

    expect(ingress.append).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "sess-1",
      event_type: "metadata",
      semantic_dedupe_key: "runner:snapshot:1",
      payload: expect.not.objectContaining({ _dedupe_key: expect.anything() }),
      session_effect: expect.objectContaining({
        kind: "append_metadata",
        replace_existing_type: "agents_run_state",
      }),
    }));
  });

  it("sanitizes and fsync-enqueues persistent events without direct event DB calls", async () => {
    const { db, appendEvent, findEventIdByDedupeKey } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );
    const event = {
      type: "assistant_message",
      content: "hi",
      timestamp: 1731700000,
      _dedupe_key: "claude-sdk:assistant:msg-1:0",
    } as unknown as SSEEventPayload;

    await expect(ep.enqueueEvent("sess-1", event)).resolves.toBe(ingress.record);

    expect(ingress.append).toHaveBeenCalledWith({
      session_id: "sess-1",
      event_type: "assistant_message",
      payload: {
        type: "assistant_message",
        content: "hi",
        timestamp: 1731700000,
      },
      searchable_text: "hi",
      created_at: "2024-11-15T19:46:40.000Z",
      semantic_dedupe_key: "claude-sdk:assistant:msg-1:0",
      session_effect: {
        kind: "last_message",
        last_message: {
          type: "assistant_message",
          preview: "hi",
          timestamp: "2024-11-15T19:46:40.000Z",
        },
        updated_at: "2024-11-15T19:46:40.000Z",
      },
    });
    expect(appendEvent).not.toHaveBeenCalled();
    expect(findEventIdByDedupeKey).not.toHaveBeenCalled();
  });

  it("sanitizes payload, searchable text, and typed effects before outbox append", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await ep.enqueueEvent(
      "sess-1",
      {
        type: "assistant_message",
        content: "before\u0000middle\ud800after 😀",
        timestamp: 1731700000,
      } as unknown as SSEEventPayload,
    );

    expect(ingress.append).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        content: "beforemiddle�after 😀",
      }),
      searchable_text: "beforemiddle�after 😀",
      session_effect: expect.objectContaining({
        last_message: expect.objectContaining({
          preview: "beforemiddle�after 😀",
        }),
      }),
    }));
  });

  it("returns the exact DB event id only after the session ACK barrier", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await expect(ep.enqueueEventAndWaitForSessionAck(
      "sess-1",
      { type: "assistant_message", content: "hi" } as unknown as SSEEventPayload,
    )).resolves.toEqual({ record: ingress.record, eventId: 42 });
    expect(ingress.waitForAcknowledgement).toHaveBeenCalledWith(ingress.record);
  });

  it("persists an idempotent running transition without waiting for host recovery", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await expect(ep.enqueueRunningTransition("sess-1", {
      reviewState: "not_required",
      transitionId: "resume:7",
      expectedTerminalEventId: 41,
      updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    })).resolves.toBe(ingress.record);

    expect(ingress.append).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "sess-1",
      semantic_dedupe_key: "running_transition:sess-1:resume:7",
      session_effect: expect.objectContaining({
        kind: "running_transition",
        expected_terminal_event_id: 41,
      }),
    }));
    expect(ingress.waitForAcknowledgement).not.toHaveBeenCalled();
  });

  it("persists an idempotent runner-adopt transition and waits for its ACK", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await expect(ep.enqueueRunningTransitionAndWaitForAck("sess-1", {
      reviewState: "not_required",
      transitionId: "adopt:command-1",
      updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    })).resolves.toBe(42);

    expect(ingress.append).toHaveBeenCalledWith({
      session_id: "sess-1",
      event_type: "metadata",
      payload: {
        type: "metadata",
        metadata_type: "session_status_transition",
        value: { status: "running", transition_id: "adopt:command-1" },
        timestamp: "2026-08-11T00:00:00.000Z",
      },
      searchable_text: "",
      created_at: "2026-08-11T00:00:00.000Z",
      semantic_dedupe_key: "running_transition:sess-1:adopt:command-1",
      session_effect: {
        kind: "running_transition",
        review_state: "not_required",
        updated_at: "2026-08-11T00:00:00.000Z",
      },
    });
    expect(ingress.waitForAcknowledgementResult).toHaveBeenCalledWith(
      ingress.record,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("returns the canonical session when a running transition CAS is rejected", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    ingress.waitForAcknowledgementResult.mockResolvedValueOnce({
      source_seq: 7,
      event_id: 42,
      effect_application: {
        applied: false,
        canonical_session: {
          status: "completed",
          termination_reason: "completed_ok",
          termination_detail: null,
          review_state: "needs_review",
          last_assistant_text: "done",
          termination_event_id: 41,
          updated_at: "2026-08-11T00:00:00.000Z",
          last_event_id: 42,
        },
      },
    });
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await expect(ep.enqueueRunningTransitionAndWaitForApplication("sess-1", {
      reviewState: "acknowledged",
      transitionId: "resume:wrong-receipt",
      expectedTerminalEventId: 999,
    })).resolves.toMatchObject({
      eventId: 42,
      applied: false,
      canonicalSession: {
        status: "completed",
        termination_event_id: 41,
      },
    });
  });

  it("maps the canonical ownership token from an applied=false ingress ACK", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    ingress.waitForAcknowledgementResult.mockResolvedValueOnce({
      source_seq: 7,
      event_id: 42,
      effect_application: {
        applied: false,
        canonical_session: {
          status: "initializing",
          termination_reason: null,
          termination_detail: null,
          review_state: "not_required",
          last_assistant_text: null,
          termination_event_id: null,
          updated_at: "2026-08-18T00:00:00.000Z",
          last_event_id: 42,
        },
        canonical_execution_ownership: {
          ownership_generation: 17,
          owner_kind: "runner_process",
          manifest_id: "release-a",
          runtime_env_identity: "env-a",
          registration_id: "registration-a",
          pid: 4101,
          start_identity: "start-a",
          execution_command_id: "owner-a",
          phase: "active",
          failure_reason: null,
        },
      },
    });
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await expect(ep.acquireExecutionOwnershipAndWaitForApplication("sess-1", {
      ownerKind: "runner_process",
      manifestId: "release-a",
      runtimeEnvIdentity: "env-a",
      registrationId: "registration-a",
      pid: 4101,
      startIdentity: "start-a",
      executionCommandId: "owner-a",
      leaseExpiresAt: new Date("2026-08-18T00:01:00.000Z"),
      reviewState: "not_required",
    })).resolves.toMatchObject({
      applied: false,
      canonicalExecutionOwnership: {
        ownershipGeneration: 17,
        ownerKind: "runner_process",
        manifestId: "release-a",
        runtimeEnvIdentity: "env-a",
        phase: "active",
      },
    });
  });

  it("publishes dead-owner expiry with the exact generation and process identity", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await ep.expireDeadExecutionOwnerAndWaitForApplication("sess-1", {
      ownershipGeneration: 17,
      pid: 968_764,
      startIdentity: "start-1",
      failureReason: "owner process is gone",
      updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    });

    expect(ingress.append).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "sess-1",
      semantic_dedupe_key: "execution_ownership:sess-1:expire-dead-owner:17",
      session_effect: {
        kind: "execution_expire_dead_owner",
        ownership_generation: 17,
        pid: 968_764,
        start_identity: "start-1",
        failure_reason: "owner process is gone",
        updated_at: "2026-08-21T00:00:00.000Z",
      },
    }));
  });

  it("returns the canonical session when a terminal transition CAS is rejected", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    ingress.waitForAcknowledgementResult.mockResolvedValueOnce({
      source_seq: 7,
      event_id: 43,
      effect_application: {
        applied: false,
        canonical_session: {
          status: "interrupted",
          termination_reason: "killed",
          termination_detail: "operator stop",
          review_state: "needs_review",
          last_assistant_text: "canonical answer",
          termination_event_id: 41,
          updated_at: "2026-08-11T00:00:00.000Z",
          last_event_id: 42,
        },
      },
    });
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );

    await expect(ep.enqueueTerminalTransitionAndWaitForApplication(
      "sess-1",
      {
        type: "session_ended",
        status: "completed",
        termination_reason: "completed_ok",
        termination_detail: null,
        timestamp: 1,
      },
      {
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
        termination_detail: null,
        review_state: "acknowledged",
        last_assistant_text: "stale answer",
        updated_at: "2026-08-12T00:00:00.000Z",
      },
    )).resolves.toMatchObject({
      eventId: 43,
      applied: false,
      canonicalSession: {
        status: "interrupted",
        termination_event_id: 41,
        last_event_id: 42,
      },
    });
    expect(ingress.waitForAcknowledgementResult).toHaveBeenCalledWith(
      ingress.record,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("waits for the last event enqueued for the session at the turn boundary", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );
    await ep.enqueueEvent(
      "sess-1",
      { type: "assistant_message", content: "hi" } as unknown as SSEEventPayload,
    );

    await expect(ep.waitForSessionAck("sess-1")).resolves.toBe(42);
    expect(ingress.waitForAcknowledgement).toHaveBeenCalledWith(ingress.record);
    await expect(ep.waitForSessionAck("sess-1")).resolves.toBeNull();
  });
});

describe("extractSearchableText", () => {
  it("text_delta는 durable 검색 대상이 아니다", () => {
    expect(
      extractSearchableText({ type: "text_delta", text: "x" } as SSEEventPayload),
    ).toBe("");
  });
  it("app-server live-only delta는 생성 중 wire 전용이라 검색 대상에서 제외한다", () => {
    expect(
      extractSearchableText({
        type: "text_delta",
        text: "partial",
        _live_only: true,
      } as unknown as SSEEventPayload),
    ).toBe("");
  });
  it("assistant_message content를 검색 대상으로 사용한다", () => {
    expect(
      extractSearchableText({
        type: "assistant_message",
        content: "answer text",
      } as unknown as SSEEventPayload),
    ).toBe("answer text");
  });
  it("user_message messages 배열에서 텍스트를 추출한다", () => {
    expect(
      extractSearchableText({
        type: "user_message",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: [{ type: "text", text: "user text" }] },
        ],
      } as unknown as SSEEventPayload),
    ).toBe("system user text");
  });

});

describe("EventPersistence transient boundary", () => {
  it("§7의 SSE event 61종을 wire schema 분류와 빠짐없이 일치시킨다", () => {
    expect(SECTION_7_ALL_EVENT_TYPES).toHaveLength(61);

    const transientTypes = new Set<string>(SECTION_7_TRANSIENT_STREAMING_TYPES);
    for (const eventType of SECTION_7_ALL_EVENT_TYPES) {
      const expectedDurability = transientTypes.has(eventType) ? "transient" : "durable";
      const event = {
        type: eventType,
        ...(transientTypes.has(eventType) ? { _live_only: true } : {}),
      } as unknown as SSEEventPayload;
      expect(EVENT_DURABILITY[eventType]).toBe(expectedDurability);
      expect(shouldPersistEvent(event)).toBe(expectedDurability === "durable");
    }
  });

  it("SSE 밖에서 outbox를 쓰는 내부 이벤트도 같은 분류 정본에 고정한다", () => {
    expect(PERSISTENCE_ONLY_EVENT_TYPES).toHaveLength(2);
    expect(new Set(Object.keys(EVENT_DURABILITY))).toEqual(
      new Set(ALL_PERSISTENCE_EVENT_TYPES),
    );

    for (const eventType of PERSISTENCE_ONLY_EVENT_TYPES) {
      const event = { type: eventType } as unknown as SSEEventPayload;
      expect(EVENT_DURABILITY[eventType]).toBe("durable");
      expect(shouldPersistEvent(event)).toBe(true);
    }
  });

  it("producer의 _live_only 표기는 durable 타입을 임의로 휘발화하지 못한다", () => {
    const event = {
      type: "progress",
      _live_only: true,
    } as unknown as SSEEventPayload;

    expect(isLiveOnlyEvent(event)).toBe(true);
    expect(shouldPersistEvent(event)).toBe(true);
  });

  it("live-only event는 durable outbox 대상이 아니다", async () => {
    const { db, appendEvent } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );
    const event = {
      type: "text_delta",
      text: "partial",
      _live_only: true,
    } as unknown as SSEEventPayload;

    expect(isLiveOnlyEvent(event)).toBe(true);
    expect(shouldPersistEvent(event)).toBe(false);
    await expect(ep.enqueueEvent("sess-1", event)).rejects.toThrow(
      /transient live events must not be persisted/,
    );
    expect(ingress.append).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("text lifecycle event는 _live_only가 없어도 durable outbox 대상이 아니다", async () => {
    const { db, appendEvent } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      ingress.outbox,
      ingress.pump,
    );
    const event = { type: "text_delta", text: "partial" } as SSEEventPayload;

    expect(shouldPersistEvent(event)).toBe(false);
    await expect(ep.enqueueEvent("sess-1", event)).rejects.toThrow(
      /transient live events must not be persisted/,
    );
    expect(ingress.append).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });
});

describe("EventPersistence.handleSideEffects", () => {
  it("text_delta는 last_message 없이 task.lastAssistantText만 갱신", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = makeEventPersistence(db, broadcaster);
    const task = makeTask();
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_delta", text: "hello", timestamp: 1731700000 } as SSEEventPayload,
      task,
    );
    expect(updateLastMessage).not.toHaveBeenCalled();
    expect(task.lastAssistantText).toBe("hello");
  });

  it("progress는 last_message 없이 task.lastProgressText만 갱신", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = makeEventPersistence(db, broadcaster);
    const task = makeTask();
    await ep.handleSideEffects(
      "sess-1",
      { type: "progress", text: "Analyzing module", timestamp: 1731700000 } as SSEEventPayload,
      task,
    );
    expect(updateLastMessage).not.toHaveBeenCalled();
    expect(task.lastProgressText).toBe("Analyzing module");
  });

  it("text_end (text 없음) — last_message 갱신 안 함 + lastAssistantText 변경 안 함", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = makeEventPersistence(db, broadcaster);
    const task = makeTask({ lastAssistantText: "previous" });
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_end", timestamp: 1731700001 } as SSEEventPayload,
      task,
    );
    expect(updateLastMessage).not.toHaveBeenCalled();
    expect(task.lastAssistantText).toBe("previous");  // 변경 없음
  });

  it("prompt_suggestion은 영속 대상이지만 last_message와 lastAssistantText는 건드리지 않는다", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = makeEventPersistence(db, broadcaster);
    const task = makeTask({ lastAssistantText: "previous" });
    await ep.handleSideEffects(
      "sess-1",
      { type: "prompt_suggestion", text: "next", timestamp: 1731700002 } as SSEEventPayload,
      task,
    );
    expect(updateLastMessage).not.toHaveBeenCalled();
    expect(task.lastAssistantText).toBe("previous");
  });

  it("legacy cumulative text_delta는 매번 덮어쓴다", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = makeEventPersistence(db, broadcaster);
    const task = makeTask();
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_delta", text: "A", timestamp: 1 } as SSEEventPayload,
      task,
    );
    expect(task.lastAssistantText).toBe("A");
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_delta", text: "AB", timestamp: 2 } as SSEEventPayload,
      task,
    );
    expect(task.lastAssistantText).toBe("AB");
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_delta", text: "ABC", timestamp: 3 } as SSEEventPayload,
      task,
    );
    expect(task.lastAssistantText).toBe("ABC");
  });

  it("app-server text_delta chunk는 text_start 이후 누적한다", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = makeEventPersistence(db, broadcaster);
    const task = makeTask({ lastAssistantText: "previous turn" });
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_start", timestamp: 1 } as SSEEventPayload,
      task,
    );
    expect(task.lastAssistantText).toBe("");
    await ep.handleSideEffects(
      "sess-1",
      {
        type: "text_delta",
        text: "Hello",
        raw_event_type: "item/agentMessage/delta",
        timestamp: 2,
      } as SSEEventPayload,
      task,
    );
    await ep.handleSideEffects(
      "sess-1",
      {
        type: "text_delta",
        text: ".",
        raw_event_type: "item/agentMessage/delta",
        timestamp: 3,
      } as SSEEventPayload,
      task,
    );
    expect(task.lastAssistantText).toBe("Hello.");
  });

  it("assistant_message is captured in runtime state without a worker DB mutation", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = makeEventPersistence(db, broadcaster);
    const task = makeTask({ lastAssistantText: "Hel" });
    const event = {
      type: "assistant_message",
      content: "Hello final answer",
      timestamp: 4,
      raw_event_type: "item/completed",
      tool_use_id: "item-1",
      _final_for_live_stream: true,
    } as unknown as SSEEventPayload;

    await ep.handleSideEffects("sess-1", event, task);

    expect(task.lastAssistantText).toBe("Hello final answer");
    expect(updateLastMessage).not.toHaveBeenCalled();
    expect(extractSearchableText(event)).toBe("Hello final answer");
  });

  it("preview 200자 cap preserves surrogate pairs in the typed effect", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ingress = makeMockIngress();
    const ep = new EventPersistence(db, broadcaster, silentLogger, ingress.outbox, ingress.pump);
    const long = `${"a".repeat(199)}😀tail`;
    await ep.enqueueEvent(
      "sess-1",
      {
        type: "assistant_message",
        content: long,
        timestamp: 1,
      } as unknown as SSEEventPayload,
    );
    const effect = ingress.append.mock.calls[0]?.[0].session_effect;
    expect(effect.last_message.preview).toBe(`${"a".repeat(199)}😀`);
    expect(Array.from(effect.last_message.preview)).toHaveLength(200);
  });

  it("F-3A T3: preview 없는 이벤트 (text_start/text_end/session 등) — broadcaster 호출 안 함", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster, emitSessionMessageUpdated } = makeMockBroadcaster();
    const ep = makeEventPersistence(db, broadcaster);

    for (const ev of [
      { type: "text_start", timestamp: 1 },
      { type: "text_end", timestamp: 2 },
      { type: "session", session_id: "thr-1", timestamp: 3 },
      { type: "tool_start", timestamp: 4 },
    ] as SSEEventPayload[]) {
      await ep.handleSideEffects("sess-1", ev, makeTask());
    }

    expect(updateLastMessage).not.toHaveBeenCalled();
    expect(emitSessionMessageUpdated).not.toHaveBeenCalled();
  });

});
