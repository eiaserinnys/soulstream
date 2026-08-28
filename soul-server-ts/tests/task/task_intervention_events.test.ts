import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
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
  it("persists intervention_sent with a surrogate-safe atomic last_message effect", async () => {
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    const append = vi.fn(async (record: {
      payload: Record<string, unknown>;
      semantic_dedupe_key: string | null;
      session_effect: Record<string, unknown> | null;
    }) => {
      const payload = JSON.stringify(record.payload);
      expect(payload).not.toContain("\\ud83d");
      expect(payload).not.toContain("followupTaskIds");
      expect(payload).not.toContain("_dedupe_key");
      expect(record.semantic_dedupe_key).toBe(
        "intervention_sent:deduped-intervention",
      );
      expect(record.payload.text).toBe(`${"a".repeat(199)}�tail`);
      expect(record.session_effect).toMatchObject({
        kind: "last_message",
        last_message: {
          type: "intervention_sent",
          preview: `${"a".repeat(199)}�`,
          timestamp: expect.any(String),
        },
        updated_at: expect.any(String),
      });
      return {
        stream_id: "stream-1",
        source_seq: 42,
        session_id: "sess-1",
        event_type: "intervention_sent",
        payload: record.payload,
        searchable_text: `${"a".repeat(199)}�tail`,
        created_at: "2026-06-10T00:00:00.000Z",
        semantic_dedupe_key: record.semantic_dedupe_key,
        session_effect: null,
        payload_hash: "a".repeat(64),
      };
    });
    const db = {} as SessionDB;
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const broadcaster = {
      emitEventEnvelope,
    } as unknown as SessionBroadcaster;
    const persistence = new EventPersistence(
      db,
      broadcaster,
      logger,
      { append } as never,
      { waitForAcknowledgement: vi.fn() } as never,
    );
    const task = makeTask();

    await publishInterventionSent(
      task,
      {
        text: `${"a".repeat(199)}\ud83dtail`,
        user: "alice",
        deliveryId: "deduped-intervention",
        followupTaskIds: ["internal-runtime-task"],
      },
      { broadcaster, logger, persistence },
    );

    expect(append).toHaveBeenCalledTimes(1);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps a durably persisted intervention accepted when last-message side effects fail", async () => {
    const logger = { warn: vi.fn() } as unknown as Logger;
    const enqueueEvent = vi.fn().mockResolvedValue({ source_seq: 43 });
    const handleSideEffects = vi.fn().mockRejectedValue(new Error("preview DB unavailable"));
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const broadcaster = { emitEventEnvelope } as unknown as SessionBroadcaster;
    const task = makeTask();

    await expect(
      publishInterventionSent(
        task,
        { text: "accepted", user: "alice" },
        {
          broadcaster,
          logger,
          persistence: { enqueueEvent, handleSideEffects } as unknown as EventPersistence,
        },
      ),
    ).resolves.toBeUndefined();

    expect(task.lastEventId).toBe(0);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1" }),
      "intervention_sent handleSideEffects failed",
    );
  });
});
