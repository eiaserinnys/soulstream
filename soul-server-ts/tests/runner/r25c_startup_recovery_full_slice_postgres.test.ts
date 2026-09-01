import { describe, expect, it } from "vitest";

import { createFullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import { ProductionFullSliceHarness } from
  "./s4_new_session_full_slice_harness.js";

describe("R25C restart-window queued delivery full slice", () => {
  it("delivers, consumes, and converges after upstream registration", async () => {
    const postgres = await createFullSchemaPostgresHarness();
    let harness: ProductionFullSliceHarness | null = null;
    try {
      harness = await ProductionFullSliceHarness.create(postgres, "R25C", "claude");
      const observed = await harness.run();

      expect(observed.restart).not.toBeNull();
      expect(observed.restart?.afterConnectionId)
        .not.toBe(observed.restart?.beforeConnectionId);
      expect(observed.runner.reattached).toBeNull();
      expect(observed.runner.firstAliveAfterInitialTerminal).toBe(false);
      expect(observed.runner.successor).not.toBeNull();
      expect(observed.runner.successor?.registrationId)
        .not.toBe(observed.runner.first.registrationId);
      expect(observed.publicAcks.filter((ack) => ack.operation === "intervene"))
        .toHaveLength(0);
      expect(observed.delivery).toEqual({
        rowCount: 1,
        deliveryId: "r25c-restart-window-queued",
        targetSessionId: observed.sessionId,
        state: "consumed",
        aggregateState: "consumed",
        consumedAt: expect.any(String),
      });
      expect(observed.durable).toMatchObject({
        status: "completed",
        assistantContents: [
          "R25C claude initial reply",
          "R25C claude resume reply",
        ],
        sessionEndedCount: 2,
        errorEventCount: 0,
        unfinishedDeliveryCount: 0,
        ghostRunningCount: 0,
      });
      expect(observed.engineBoundaryProbes.filter(
        (probe) => probe.call === "intervene",
      )).toHaveLength(0);
      expect(observed.engineBoundaryProbes.filter(
        (probe) => probe.call === "executeFrames",
      )).toHaveLength(2);
    } finally {
      await harness?.cleanup();
      await postgres.cleanup();
    }
  }, 120_000);
});
