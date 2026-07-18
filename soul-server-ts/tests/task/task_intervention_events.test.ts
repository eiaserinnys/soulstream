import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { publishInterventionSent } from "../../src/task/task_intervention_events.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "initial",
    status: "running",
    profileId: "claude-default",
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

describe("publishInterventionSent", () => {
  it("persists intervention_sent with safe JSON and surrogate-safe last_message preview", async () => {
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    const appendEvent = vi.fn(async (record: { payload: string }) => {
      expect(record.payload).not.toContain("\\ud83d");
      expect(record.payload).not.toContain("followupTaskIds");
      expect(JSON.parse(record.payload).text).toBe(`${"a".repeat(199)}�tail`);
      return 42;
    });
    const updateLastMessage = vi.fn().mockResolvedValue(undefined);
    const db = { appendEvent, updateLastMessage } as unknown as SessionDB;
    const emitSessionMessageUpdated = vi.fn().mockResolvedValue(undefined);
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const broadcaster = {
      emitSessionMessageUpdated,
      emitEventEnvelope,
    } as unknown as SessionBroadcaster;
    const persistence = new EventPersistence(db, broadcaster, logger);
    const task = makeTask();

    await publishInterventionSent(
      task,
      {
        text: `${"a".repeat(199)}\ud83dtail`,
        user: "alice",
        followupTaskIds: ["internal-runtime-task"],
      },
      { broadcaster, logger, persistence },
    );

    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(updateLastMessage).toHaveBeenCalledWith("sess-1", {
      type: "intervention_sent",
      preview: `${"a".repeat(199)}�`,
      timestamp: expect.any(String),
    });
    expect(emitSessionMessageUpdated).toHaveBeenCalledWith(
      "sess-1",
      "running",
      expect.any(String),
      {
        type: "intervention_sent",
        preview: `${"a".repeat(199)}�`,
        timestamp: expect.any(String),
      },
      42,
      0,
    );
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "intervention_sent",
        _event_id: 42,
      }) as SSEEventPayload,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
