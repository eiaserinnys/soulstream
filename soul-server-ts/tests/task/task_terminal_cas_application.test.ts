import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { TaskExecutorFinalizer } from
  "../../src/task/task_executor_finalizer.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { EventOutbox } from "../../src/upstream/event_outbox.js";
import { EventOutboxPump } from
  "../../src/upstream/event_outbox_pump.js";
import type { SessionBroadcaster } from
  "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("terminal transition application chain", () => {
  it("projects a rejected canonical ACK and suppresses a new completion delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "soulstream-terminal-cas-"));
    tempDirectories.push(directory);
    const outbox = await EventOutbox.open(directory);
    const pumpErrors: unknown[] = [];
    const pump = new EventOutboxPump(outbox, (error) => pumpErrors.push(error));
    const persistence = new EventPersistence(
      {} as SessionDB,
      {} as SessionBroadcaster,
      silentLogger,
      outbox,
      pump,
    );
    const lifecycleTransition = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence,
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition,
      logger: silentLogger,
      completionNotifier: { notify },
    });
    const task: Task = {
      agentSessionId: "sess-1",
      callerSessionId: "caller-1",
      prompt: "stale completion",
      status: "completed",
      result: "stale result",
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
      completedAt: new Date("2026-08-12T00:00:00.000Z"),
      lastEventId: 7,
      lastReadEventId: 0,
      interventionQueue: [],
    };

    const finalization = finalizer.finalize(task);
    await expect(Promise.race([
      finalization.then(() => "finalized"),
      Promise.resolve("pending"),
    ])).resolves.toBe("pending");

    pump.connect(async (batch) => {
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.session_effect).toMatchObject({
        kind: "terminal_transition",
        status: "completed",
      });
      await pump.handleAck({
        type: "event_append_ack",
        stream_id: batch.stream_id,
        acked_through: batch.events[0]!.source_seq,
        events: [{
          source_seq: batch.events[0]!.source_seq,
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
              updated_at: "2026-08-11T12:00:00.000Z",
              last_event_id: 42,
            },
          },
        }],
      });
    });

    await finalization;

    expect(task).toMatchObject({
      status: "interrupted",
      terminationReason: "killed",
      terminationDetail: "operator stop",
      reviewState: "needs_review",
      lastAssistantText: "canonical answer",
      terminalEventId: 41,
      lastEventId: 42,
      terminationEventRecorded: true,
    });
    expect(task.completedAt?.toISOString()).toBe("2026-08-11T12:00:00.000Z");
    expect(notify).not.toHaveBeenCalled();
    expect(pumpErrors).toEqual([]);
  });
});
