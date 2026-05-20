import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EventPersistence,
  extractPreviewText,
  extractSearchableText,
} from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

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
  const updateLastMessage = vi.fn().mockResolvedValue(undefined);
  return {
    db: { appendEvent, updateLastMessage } as unknown as SessionDB,
    appendEvent,
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

const silentLogger = pino({ level: "silent" });

describe("extractPreviewText", () => {
  it("text_delta는 text 필드", () => {
    expect(
      extractPreviewText({ type: "text_delta", text: "hello" } as SSEEventPayload),
    ).toBe("hello");
  });
  it("thinking은 thinking 필드", () => {
    expect(
      extractPreviewText({ type: "thinking", thinking: "..." } as SSEEventPayload),
    ).toBe("...");
  });
  it("complete은 result 필드", () => {
    expect(
      extractPreviewText({ type: "complete", result: "done" } as SSEEventPayload),
    ).toBe("done");
  });
  it("error는 message 필드", () => {
    expect(
      extractPreviewText({ type: "error", message: "err" } as SSEEventPayload),
    ).toBe("err");
  });
  it("매핑 없는 event는 빈 문자열", () => {
    expect(
      extractPreviewText({ type: "tool_start" } as SSEEventPayload),
    ).toBe("");
  });
  it("prompt_suggestion과 credential_alert는 turn-meta라 last_message preview에 쓰지 않는다", () => {
    expect(
      extractPreviewText({ type: "prompt_suggestion", text: "next" } as SSEEventPayload),
    ).toBe("");
    expect(
      extractPreviewText({ type: "credential_alert", utilization: 0.95 } as SSEEventPayload),
    ).toBe("");
  });
  it("input_request lifecycle events는 last_message preview에 쓰지 않는다", () => {
    for (const event of [
      { type: "input_request", request_id: "ask-1", questions: [{ question: "Q" }] },
      { type: "input_request_responded", request_id: "ask-1" },
      { type: "input_request_expired", request_id: "ask-1" },
    ] as SSEEventPayload[]) {
      expect(extractPreviewText(event)).toBe("");
      expect(extractSearchableText(event)).toBe("");
    }
  });
  it("text_end는 text 필드가 없으므로 빈 문자열 (B-2 결함 정정 검증)", () => {
    expect(extractPreviewText({ type: "text_end" } as SSEEventPayload)).toBe("");
  });
});

describe("extractSearchableText", () => {
  it("preview와 같은 텍스트", () => {
    expect(
      extractSearchableText({ type: "text_delta", text: "x" } as SSEEventPayload),
    ).toBe("x");
  });
});

describe("EventPersistence.persistEvent", () => {
  it("appendEvent에 type/payload/searchable/timestamp 전달, event_id 반환", async () => {
    const { db, appendEvent } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);
    const event = { type: "text_delta", text: "hi", timestamp: 1731700000 } as SSEEventPayload;
    const id = await ep.persistEvent("sess-1", event);
    expect(id).toBe(42);
    expect(appendEvent).toHaveBeenCalledTimes(1);
    const arg = appendEvent.mock.calls[0][0];
    expect(arg.sessionId).toBe("sess-1");
    expect(arg.eventType).toBe("text_delta");
    expect(JSON.parse(arg.payload)).toEqual(event);
    expect(arg.searchableText).toBe("hi");
    expect(arg.createdAt).toBeInstanceOf(Date);
    expect(arg.createdAt.getTime()).toBe(1731700000 * 1000);
  });

  it("timestamp 부재 시 호출 시점 now", async () => {
    const { db, appendEvent } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);
    await ep.persistEvent("sess-1", { type: "tool_start" } as SSEEventPayload);
    const arg = appendEvent.mock.calls[0][0];
    expect(arg.createdAt).toBeInstanceOf(Date);
  });
});

describe("EventPersistence.handleSideEffects", () => {
  it("text_delta는 last_message 갱신 + task.lastAssistantText 누적", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);
    const task = makeTask();
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_delta", text: "hello", timestamp: 1731700000 } as SSEEventPayload,
      task,
    );
    expect(updateLastMessage).toHaveBeenCalledTimes(1);
    const arg = updateLastMessage.mock.calls[0][1];
    expect(arg.type).toBe("text_delta");
    expect(arg.preview).toBe("hello");
    expect(typeof arg.timestamp).toBe("string");
    expect(task.lastAssistantText).toBe("hello");
  });

  it("progress는 last_message 없이 task.lastProgressText만 갱신", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);
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
    const ep = new EventPersistence(db, broadcaster, silentLogger);
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
    const ep = new EventPersistence(db, broadcaster, silentLogger);
    const task = makeTask({ lastAssistantText: "previous" });
    await ep.handleSideEffects(
      "sess-1",
      { type: "prompt_suggestion", text: "next", timestamp: 1731700002 } as SSEEventPayload,
      task,
    );
    expect(updateLastMessage).not.toHaveBeenCalled();
    expect(task.lastAssistantText).toBe("previous");
  });

  it("text_delta 누적 — 매번 덮어쓰기 (Codex SDK 누적 텍스트 정합)", async () => {
    const { db } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);
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

  it("preview 200자 cap", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);
    const long = "a".repeat(250);
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_delta", text: long, timestamp: 1 } as SSEEventPayload,
      makeTask(),
    );
    const arg = updateLastMessage.mock.calls[0][1];
    expect(arg.preview).toHaveLength(200);
  });

  it("updateLastMessage throw → 호출자 전파 + wire 미발행 (Python 정합: DB·wire 일관성)", async () => {
    const appendEvent = vi.fn();
    const updateLastMessage = vi.fn().mockRejectedValue(new Error("db down"));
    const db = { appendEvent, updateLastMessage } as unknown as SessionDB;
    const { broadcaster, emitSessionMessageUpdated } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);
    await expect(
      ep.handleSideEffects(
        "sess-1",
        { type: "text_delta", text: "x", timestamp: 1 } as SSEEventPayload,
        makeTask(),
      ),
    ).rejects.toThrow(/db down/);

    // 호출자(task_executor._processEvent)가 try로 감싸 격리. 여기서는 throw 전파만 검증.
    // wire는 *미발행* — DB 미갱신 상태로 wire를 보내면 클라이언트가 last_message 보고 새로
    // 그렸다가 다음 list refresh에서 이전 값으로 회귀하는 transient 불일치 방지.
    expect(emitSessionMessageUpdated).not.toHaveBeenCalled();
  });

  // === F-3A: emit_session_message_updated wire 발행 ===

  it("F-3A T2: preview 있을 때 emitSessionMessageUpdated 호출 (Python L141-221 정합)", async () => {
    const { db } = makeMockDB();
    const { broadcaster, emitSessionMessageUpdated } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);
    const task = makeTask({
      status: "running",
      lastEventId: 5,
      lastReadEventId: 3,
    });
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_delta", text: "hello world", timestamp: 1731700000 } as SSEEventPayload,
      task,
    );

    expect(emitSessionMessageUpdated).toHaveBeenCalledTimes(1);
    const args = emitSessionMessageUpdated.mock.calls[0];
    expect(args[0]).toBe("sess-1");                    // agentSessionId
    expect(args[1]).toBe("running");                   // status
    expect(typeof args[2]).toBe("string");             // updatedAt (ISO)
    expect(args[3]).toEqual({                          // lastMessage
      type: "text_delta",
      preview: "hello world",
      timestamp: args[2],                              // DB 갱신과 같은 ts
    });
    expect(args[4]).toBe(5);                           // lastEventId
    expect(args[5]).toBe(3);                           // lastReadEventId
  });

  it("F-3A T3: preview 없는 이벤트 (text_start/text_end/session 등) — broadcaster 호출 안 함", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const { broadcaster, emitSessionMessageUpdated } = makeMockBroadcaster();
    const ep = new EventPersistence(db, broadcaster, silentLogger);

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

  it("F-3A T4: broadcaster throw → 격리 (DB 갱신은 성공 + lastAssistantText 누적 정상)", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const broadcaster = {
      emitSessionMessageUpdated: vi
        .fn()
        .mockRejectedValue(new Error("wire down")),
    } as unknown as SessionBroadcaster;
    const ep = new EventPersistence(db, broadcaster, silentLogger);
    const task = makeTask();

    await expect(
      ep.handleSideEffects(
        "sess-1",
        { type: "text_delta", text: "hello", timestamp: 1 } as SSEEventPayload,
        task,
      ),
    ).resolves.toBeUndefined();

    // DB 갱신은 성공
    expect(updateLastMessage).toHaveBeenCalledTimes(1);
    // lastAssistantText 누적은 정상 동작
    expect(task.lastAssistantText).toBe("hello");
  });
});
