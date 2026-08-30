import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CompletedParentS5FullSliceHarness } from
  "./completed_parent_child_completion_full_slice_harness.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

const ACTUAL_FOUR_LINE_SCENARIO = [
  "notify=true child persists one terminal revision",
  "completion notifier persists one pending delivery",
  "parent remains completed after its ordinary turn",
  "terminal settlement runs before completion claim",
] as const;

describePostgres("completed-parent pending completion ownership", () => {
  let postgres: FullSchemaPostgresHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => {
    await postgres?.cleanup();
  });

  it("preserves pending ownership through settlement and wakes the parent exactly once", async () => {
    expect(ACTUAL_FOUR_LINE_SCENARIO).toHaveLength(4);
    const harness = await CompletedParentS5FullSliceHarness.create(postgres, {
      pauseAfterCompletionRegistration: true,
    });
    try {
      const admitted = await harness.notifyThroughPendingTerminalSettlement();
      expect(admitted).toMatchObject({
        beforeSettlementState: "pending",
        afterSettlementState: "pending",
        releasedLeaseCount: 0,
        activation: {
          startBoundary: {
            deliveryId: admitted.activation.correlationId,
            taskStatus: "initializing",
            activationAttached: true,
          },
          ownership: {
            status: "running",
            execution_generation: 1,
          },
          input: {
            inputUuid: admitted.activation.expectedInputUuid,
            turnOrigin: { kind: "completion_notification" },
          },
        },
      });

      const settled = await harness.finish();
      expect(settled.delivery).toMatchObject({
        state: "consumed",
        aggregate_state: "consumed",
        attempt_count: 0,
      });
      await expect(harness.readExactOnceCountsAfterRetryHorizon()).resolves.toEqual({
        childTerminal: 1,
        completionDelivery: 1,
        parentAutoResumeGeneration: 1,
        completionConsume: 1,
        retryHorizonClaims: 0,
      });
    } finally {
      await harness.cleanup();
    }
  }, 45_000);
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
