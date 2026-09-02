import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import {
  P0R2_DELIVERY_ID,
  P0R2FullSliceHarness,
} from "./p0r2_resume_writer_lock_full_slice_harness.js";

describe("P0-R2 resume writer-lock full slice", () => {
  let postgres: FullSchemaPostgresHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => {
    await postgres.cleanup();
  });

  it("retires the old writer before the exact-once successor becomes eligible", async () => {
    const harness = await P0R2FullSliceHarness.create(postgres);
    try {
      const observed = await harness.run();
      const expectedInputUuid = buildDeliveryInputUuid(P0R2_DELIVERY_ID);

      expect(observed.routeResult).toEqual({ autoResumed: true });
      expect(observed.routeError).toBeNull();
      expect(observed.interruptCount).toBeLessThanOrEqual(1);
      expect(observed.successorExecution).not.toBeNull();
      expect(observed.successorActivation).toMatchObject({
        status: "running",
        registrationId: expect.any(String),
        commandId: expect.any(String),
        registrationPid: expect.any(Number),
        registrationStartIdentity: expect.any(String),
      });
      if (observed.successorExecution && observed.successorActivation) {
        expect(observed.successorExecution.pid).not.toBe(observed.firstExecution.pid);
        expect(observed.successorExecution.params).toMatchObject({
          inputUuid: expectedInputUuid,
          turnOrigin: { kind: "user_message", id: P0R2_DELIVERY_ID },
        });
        expect(observed.successorActivation.registrationPid)
          .toBe(observed.successorExecution.pid);
      }

      expect(observed.registration.firstRecord).toMatchObject({
        status: "running",
        registrationId: expect.any(String),
        commandId: expect.any(String),
      });
      expect(observed.registration.firstClear).toMatchObject({
        status: "completed",
        terminationEventId: expect.any(Number),
        terminationCreatedAt: expect.any(String),
        registrationCleared: true,
      });
      expect(observed.registration.successorRecordEventId)
        .toBeGreaterThan(observed.registration.firstClear.terminationEventId);
      expect(observed.registration.finalClear).toMatchObject({
        status: "completed",
        terminationEventId: expect.any(Number),
        terminationCreatedAt: expect.any(String),
        registrationCleared: true,
      });
      expect(observed.persistedSuccessorReplyCount).toBe(1);
      expect(observed.sseSuccessorReplyCount).toBe(1);
      expect(observed.delivery).toEqual({
        state: "consumed",
        aggregateState: "consumed",
        attemptCount: 0,
        acceptedCount: 1,
        retryCount: 0,
        lastError: null,
      });
      expect(observed.session).toEqual({
        status: "completed",
        registrationId: null,
        commandId: null,
        terminationEventId: expect.any(Number),
      });
      expect(observed.errorEventCount).toBe(0);
      expect(observed.task).toEqual({
        status: "completed",
        runnerAttached: false,
        executionPromiseAttached: false,
        activationAttached: false,
        queueLength: 0,
      });
      expect(observed.pumpErrors).toEqual([]);

      // Admission must not begin until the previous child, registration,
      // and writer lock have all retired.
      expect(observed.handoff).toEqual({
        oldPidAlive: false,
        writerLockPresent: false,
        registrationPid: null,
      });
    } finally {
      await harness.cleanup();
    }
  }, 45_000);
});
