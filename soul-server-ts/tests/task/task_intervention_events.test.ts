import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { buildUserMessageEvent } from "../../src/task/task_user_message_events.js";
import { publishInterventionSent } from "../../src/task/task_intervention_events.js";
import { buildInterventionSentEvent } from "../../src/task/task_intervention_events.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
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
      expect(record.payload.input_id).toBe(buildDeliveryInputUuid("deduped-intervention"));
      expect(record.session_effect).toMatchObject({
        kind: "last_message",
        last_message: {
          type: "user_message",
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

  it("propagates intervention_sent enqueue failures", async () => {
    const logger = { warn: vi.fn() } as unknown as Logger;
    const enqueueEvent = vi.fn().mockRejectedValue(new Error("outbox down"));
    const task = makeTask();

    await expect(
      publishInterventionSent(
        task,
        { text: "accepted", user: "alice" },
        {
          broadcaster: {} as SessionBroadcaster,
          logger,
          persistence: {
            enqueueEvent,
            handleSideEffects: vi.fn(),
          } as unknown as EventPersistence,
        },
      ),
    ).rejects.toThrow("outbox down");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1" }),
      "intervention_sent persistence failed",
    );
  });
});

describe("buildInterventionSentEvent attachment identity", () => {
  it("dedupes attachment ids and counts an admitted binding once", () => {
    const event = buildInterventionSentEvent({
      text: "",
      user: "alice",
      attachmentPaths: ["/tmp/a.png"],
      attachmentIds: ["att-a", "att-a"],
      attachmentBindings: [
        { attachment_id: "att-a", node_id: "node-1", path: "/tmp/a.png" },
      ],
    });

    expect(event.text).toBe("");
    expect(event.attachment_ids).toEqual(["att-a"]);
    expect(event.attachment_count).toBe(1);
    expect(event.attachments).toEqual(["/tmp/a.png"]);
  });

  it("counts an unbound legacy path alongside attachment ids", () => {
    const event = buildInterventionSentEvent({
      text: "hi",
      user: "alice",
      attachmentPaths: ["/tmp/b.png"],
      attachmentIds: ["att-a"],
    });

    expect(event.attachment_count).toBe(2);
  });

  it("omits attachment identity keys for a plain message", () => {
    const event = buildInterventionSentEvent({ text: "hi", user: "alice" });

    expect(event.attachment_ids).toBeUndefined();
    expect(event.attachment_count).toBeUndefined();
    expect(event.attachments).toBeUndefined();
  });
});

describe("managed attachment path note normalization", () => {
  const bindings = [
    { attachment_id: "att-a", node_id: "node-1", path: "/tmp/a.png" },
    { attachment_id: "att-b", node_id: "node-1", path: "/tmp/b.txt" },
  ];
  const attachmentPaths = ["/tmp/a.png", "/tmp/b.txt"];

  it("strips only the trailing managed note block from user_message text", () => {
    const event = buildUserMessageEvent({
      text:
        "inspect these\n\n" +
        "[첨부 파일 로컬 경로: /tmp/a.png]\n" +
        "[첨부 파일 로컬 경로: /tmp/b.txt]",
      inputId: "input-1",
      attachmentPaths,
      attachmentIds: ["att-a", "att-b"],
      attachmentBindings: bindings,
    });

    expect(event.text).toBe("inspect these");
    expect(event.input_id).toBe("input-1");
    expect(event.attachment_ids).toEqual(["att-a", "att-b"]);
    expect(event.attachment_count).toBe(2);
    expect(event.attachments).toEqual(attachmentPaths);
  });

  it("strips a note-only intervention to empty text and preserves attachment fields", () => {
    const event = buildInterventionSentEvent({
      text: "[첨부 파일 로컬 경로: /tmp/a.png]",
      user: "alice",
      deliveryId: "delivery-1",
      attachmentPaths: [attachmentPaths[0]!],
      attachmentIds: ["att-a"],
      attachmentBindings: [bindings[0]!],
    });

    expect(event.text).toBe("");
    expect(event.input_id).toBe(buildDeliveryInputUuid("delivery-1"));
    expect(event.attachment_ids).toEqual(["att-a"]);
    expect(event.attachment_count).toBe(1);
    expect(event.attachments).toEqual(["/tmp/a.png"]);
  });
});
