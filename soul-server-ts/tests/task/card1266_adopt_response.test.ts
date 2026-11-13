import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import { EventOutboxDeadLetterError, EventOutboxQuarantinedError }
  from "../../src/upstream/event_outbox_pump_protocol.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

function makeSubject(
  respond: () => Promise<unknown>,
) {
  const double = makeEventPersistenceTestDouble();
  Object.assign(double.persistence, {
    enqueueRunningTransitionAndWaitForApplication: vi.fn(respond),
  });
  const engine = {
    backendId: "codex",
    workspaceDir: "/tmp/a",
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
  } as unknown as EnginePort;
  const executor = new TaskExecutor(
    () => engine,
    { updateSession: vi.fn(), getSession: vi.fn() } as unknown as SessionDB,
    double.persistence,
    { emitEventEnvelope: vi.fn(), emitSessionUpdated: vi.fn() } as unknown as SessionBroadcaster,
    pino({ level: "silent" }),
  );
  const task: Task = {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date(),
    lastEventId: 3,
    lastReadEventId: 0,
    interventionQueue: [],
    runner: {
      engine,
      dispatcher: { registrationId: () => "registration-1" } as never,
      eventPersistence: "runner",
    },
  };
  return { executor, task };
}

const session = (status = "completed") => ({
  status,
  termination_reason: null,
  termination_detail: null,
  review_state: "not_required",
  last_assistant_text: null,
  termination_event_id: null,
  updated_at: "2026-11-13T00:00:00.000Z",
  last_event_id: 3,
});

describe("card #1266 U2a adoption response", () => {
  it("classifies a dead-lettered adoption as a no-retry rejection without a reason", async () => {
    const subject = makeSubject(async () => {
      throw new EventOutboxDeadLetterError(
        4, "REPEATED_FAILURE", "2026-11-13T00:00:01.000Z", "repeated failure",
      );
    });
    await expect(subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1"))
      .resolves.toEqual({ applied: false, response: "terminal_rejection" });
  });

  it("classifies a quarantined adoption as a no-retry rejection", async () => {
    const subject = makeSubject(async () => {
      throw new EventOutboxQuarantinedError(
        4, "INVALID_EVENT", "2026-11-13T00:00:01.000Z", "invalid",
      );
    });
    await expect(subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1"))
      .resolves.toMatchObject({ applied: false, response: "terminal_rejection" });
  });

  it("keeps a stale registration's rejection retryable so the runner is not reaped", async () => {
    const subject = makeSubject(async () => ({
      eventId: 5,
      applied: false,
      rejectionReason: "already_terminal",
      canonicalSession: session(),
      canonicalExecutionRegistration: {
        registrationId: "registration-other",
        executionCommandId: "execute-other",
      },
    }));
    await expect(subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1"))
      .resolves.toMatchObject({ applied: false, response: "retryable_rejection" });
  });

  it("rethrows a failure that is not a server response", async () => {
    const subject = makeSubject(async () => { throw new Error("socket closed"); });
    await expect(subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1"))
      .rejects.toThrow("socket closed");
  });
});
