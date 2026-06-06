import pino from "pino";
import { vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { LlmAdapter, LlmResult } from "../../src/llm/types.js";
import { TaskManager } from "../../src/task/task_manager.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

export const silentLogger = pino({ level: "silent" });

export function makeLlmHarness(adapter?: LlmAdapter) {
  let eventId = 0;
  const registerSession = vi.fn().mockResolvedValue(undefined);
  const appendMetadata = vi.fn().mockResolvedValue(1);
  const updateSession = vi.fn().mockResolvedValue(undefined);
  const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
  const getFolderById = vi
    .fn()
    .mockResolvedValue({
      id: "llm",
      name: "사용자가 바꾼 LLM 폴더 이름",
      sort_order: 1,
      settings: {},
      parent_folder_id: null,
    });
  const getCatalog = vi.fn().mockResolvedValue({ folders: [], sessions: {} });
  const appendEvent = vi.fn().mockImplementation(async () => {
    eventId += 1;
    return eventId;
  });
  const updateLastMessage = vi.fn().mockResolvedValue(undefined);

  const db = {
    registerSession,
    appendMetadata,
    updateSession,
    assignSessionToFolder,
    getFolderById,
    getCatalog,
    appendEvent,
    updateLastMessage,
  } as unknown as SessionDB;

  const sent: unknown[] = [];
  const broadcaster = new SessionBroadcaster(
    async (data) => {
      sent.push(data);
    },
    { get: () => undefined } as unknown as AgentRegistry,
    "test-node",
  );
  const persistence = new EventPersistence(db, broadcaster, silentLogger);
  const taskManager = new TaskManager("test-node", db, broadcaster, silentLogger);

  return {
    adapter: adapter ?? new MockLlmAdapter(),
    db,
    taskManager,
    persistence,
    broadcaster,
    sent,
    mocks: {
      registerSession,
      appendMetadata,
      updateSession,
      assignSessionToFolder,
      getFolderById,
      getCatalog,
      appendEvent,
      updateLastMessage,
    },
  };
}

export class MockLlmAdapter implements LlmAdapter {
  readonly complete = vi.fn(
    async (): Promise<LlmResult> => ({
      content: "Mock response",
      inputTokens: 10,
      outputTokens: 5,
    }),
  );
}

export class FailingLlmAdapter implements LlmAdapter {
  readonly complete = vi.fn(async (): Promise<LlmResult> => {
    throw new Error("API call failed: rate limited");
  });
}
