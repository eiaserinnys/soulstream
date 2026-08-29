import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import {
  S1S2_DELIVERY_ID,
  S1S2FullSliceHarness,
  type S1S2Observation,
} from "./s1_s2_restart_resume_full_slice_harness.js";

describe("S1+S2 restart and explicit-resume full slice", () => {
  let postgres: FullSchemaPostgresHarness;
  let harness: S1S2FullSliceHarness;
  let observed: S1S2Observation;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    harness = await S1S2FullSliceHarness.create(postgres);
    observed = await harness.run();
  }, 45_000);

  afterAll(async () => {
    await harness?.cleanup();
    await postgres?.cleanup();
  });

  it("S1 reattaches the same runner and completes 120 logical seconds without loss", () => {
    expect(observed.s1).toEqual({
      firstPid: expect.any(Number),
      recoveredPid: observed.s1.firstPid,
      registrationIdBefore: expect.any(String),
      registrationIdAfter: observed.s1.registrationIdBefore,
      startIdentityBefore: expect.any(String),
      startIdentityAfter: observed.s1.startIdentityBefore,
      executionGeneration: 1,
      persistedWorkAtZeroCount: 1,
      persistedWorkAt120Count: 1,
      sseWorkAtZeroCount: 1,
      sseWorkAt120Count: 1,
      sseTerminalCount: 1,
      terminalEventCount: 1,
      acquireEventCount: 1,
      assistantReceiptCount: 2,
    });
    expect(observed.ownership.firstAcquire).toMatchObject({
      status: "running",
      executionGeneration: 1,
      registrationId: observed.s1.registrationIdBefore,
      pid: observed.s1.firstPid,
      startIdentity: observed.s1.startIdentityBefore,
    });
    expect(observed.ownership.firstRelease).toMatchObject({
      status: "completed",
      executionGeneration: 1,
      terminationEventId: expect.any(Number),
      executionIdentityCleared: true,
    });
  });

  it("S2 hands explicit resume to one new generation after the old runner retires", () => {
    const expectedInputUuid = buildDeliveryInputUuid(S1S2_DELIVERY_ID);
    expect(observed.routeResult).toEqual({ autoResumed: true });
    expect(observed.routeError).toBeNull();
    expect(observed.handoff).toEqual({
      oldPidAlive: false,
      writerLockPresent: false,
      registrationPid: null,
    });
    expect(observed.successorExecution).not.toBeNull();
    expect(observed.successorActivation).toMatchObject({
      status: "running",
      executionGeneration: 2,
      registrationId: expect.any(String),
      pid: expect.any(Number),
      startIdentity: expect.any(String),
      registrationPid: expect.any(Number),
      registrationStartIdentity: expect.any(String),
    });
    if (!observed.successorExecution || !observed.successorActivation) {
      throw new Error("S2 successor admission was not observed");
    }
    expect(observed.successorExecution.pid).not.toBe(observed.s1.firstPid);
    expect(observed.successorExecution.params).toMatchObject({
      inputUuid: expectedInputUuid,
      resumeSessionId: "backend-session-s1s2-1",
      turnOrigin: { kind: "user_message", id: S1S2_DELIVERY_ID },
    });
    expect(observed.successorActivation.pid).toBe(observed.successorExecution.pid);
    expect(observed.successorActivation.registrationPid).toBe(observed.successorExecution.pid);
    expect(observed.successorActivation.startIdentity)
      .toBe(observed.successorActivation.registrationStartIdentity);
    expect(observed.ownership.successorAcquireEventId)
      .toBeGreaterThan(observed.ownership.firstRelease.terminationEventId);
    expect(observed.ownership.finalRelease).toMatchObject({
      status: "completed",
      executionGeneration: 2,
      terminationEventId: expect.any(Number),
      executionIdentityCleared: true,
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
      executionGeneration: 2,
      manifestId: null,
      registrationId: null,
      pid: null,
      startIdentity: null,
      commandId: null,
      terminationEventId: expect.any(Number),
      terminalEventCount: 2,
    });
    expect(observed.ownership.legacyRowCount).toBe(0);
    expect(observed.ownership.legacyOpenRowCount).toBe(0);
    expect(observed.errorEventCount).toBe(0);
    expect(observed.interruptCount).toBe(0);
    expect(observed.task).toEqual({
      status: "completed",
      runnerAttached: false,
      executionPromiseAttached: false,
      activationAttached: false,
      queueLength: 0,
    });
    expect(observed.pumpErrors).toEqual([]);
  });
});
