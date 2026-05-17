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
    const ep = new EventPersistence(db, silentLogger);
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
    const ep = new EventPersistence(db, silentLogger);
    await ep.persistEvent("sess-1", { type: "tool_start" } as SSEEventPayload);
    const arg = appendEvent.mock.calls[0][0];
    expect(arg.createdAt).toBeInstanceOf(Date);
  });
});

describe("EventPersistence.handleSideEffects", () => {
  it("text_delta는 last_message 갱신 + task.lastAssistantText 누적", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const ep = new EventPersistence(db, silentLogger);
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

  it("text_end (text 없음) — last_message 갱신 안 함 + lastAssistantText 변경 안 함", async () => {
    const { db, updateLastMessage } = makeMockDB();
    const ep = new EventPersistence(db, silentLogger);
    const task = makeTask({ lastAssistantText: "previous" });
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_end", timestamp: 1731700001 } as SSEEventPayload,
      task,
    );
    expect(updateLastMessage).not.toHaveBeenCalled();
    expect(task.lastAssistantText).toBe("previous");  // 변경 없음
  });

  it("text_delta 누적 — 매번 덮어쓰기 (Codex SDK 누적 텍스트 정합)", async () => {
    const { db } = makeMockDB();
    const ep = new EventPersistence(db, silentLogger);
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
    const ep = new EventPersistence(db, silentLogger);
    const long = "a".repeat(250);
    await ep.handleSideEffects(
      "sess-1",
      { type: "text_delta", text: long, timestamp: 1 } as SSEEventPayload,
      makeTask(),
    );
    const arg = updateLastMessage.mock.calls[0][1];
    expect(arg.preview).toHaveLength(200);
  });

  it("updateLastMessage 실패해도 throw 안 함 (실패 격리)", async () => {
    const appendEvent = vi.fn();
    const updateLastMessage = vi.fn().mockRejectedValue(new Error("db down"));
    const db = { appendEvent, updateLastMessage } as unknown as SessionDB;
    const ep = new EventPersistence(db, silentLogger);
    await expect(
      ep.handleSideEffects(
        "sess-1",
        { type: "text_delta", text: "x", timestamp: 1 } as SSEEventPayload,
        makeTask(),
      ),
    ).resolves.toBeUndefined();
  });
});
