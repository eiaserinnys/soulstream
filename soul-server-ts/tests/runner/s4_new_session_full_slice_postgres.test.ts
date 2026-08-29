import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import { S4NewSessionFullSliceHarness } from
  "./s4_new_session_full_slice_harness.js";

describe("S4 fresh session terminal full slice", () => {
  let postgres: FullSchemaPostgresHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => {
    await postgres.cleanup();
  });

  it("starts on the new server, completes visibly, and retires local ownership", async () => {
    const harness = await S4NewSessionFullSliceHarness.create(postgres);
    try {
      const observed = await harness.run();

      expect.soft(observed.entry).toEqual({
        callCount: 1,
        status: "initializing",
        prompt: "S4 fresh-session prompt",
        runnerAttached: false,
        ownershipAttached: false,
        executionPromiseAttached: false,
        pidPresent: false,
        socketPresent: false,
        lockPresent: false,
      });
      expect.soft(observed.child).toMatchObject({
        pid: expect.any(Number),
        prompt: "S4 fresh-session prompt",
        executionGeneration: 1,
      });
      expect.soft(observed.receipt.receiptCount).toBe(observed.receipt.durableEventCount);
      expect.soft(observed.receipt.deliveryCount).toBe(0);
      expect.soft(observed.receipt.pumpErrors).toEqual([]);
      expect.soft(observed.terminal).toEqual({
        status: "completed",
        terminationReason: "completed_ok",
        executionGeneration: 1,
        executionIdentityCleared: true,
        acquireCount: 1,
        releaseCount: 1,
      });
      expect.soft(observed.userVisible).toEqual({
        statusCode: 200,
        assistantReplyCount: 1,
        completionCount: 1,
      });
      expect.soft(observed.nextTurn.startExecutionCallCount).toBe(1);
      expect.soft(observed.cleanup).toEqual({
        taskStatus: "completed",
        runnerAttached: false,
        executionPromiseAttached: false,
        registrationPid: null,
        pidPresent: false,
        socketPresent: false,
        lockPresent: false,
        pidAlive: false,
      });
    } finally {
      await harness.cleanup();
    }
  }, 45_000);
});
