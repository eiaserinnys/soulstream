import { describe, expect, it } from "vitest";

import { createFullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import { ProductionFullSliceHarness } from
  "./s4_new_session_full_slice_harness.js";

describe("S7 ghost-running delivery production full slice", () => {
  it("attaches a fresh turn and converges every durable fact", async () => {
    const postgres = await createFullSchemaPostgresHarness();
    let harness: ProductionFullSliceHarness | null = null;
    let scenarioError: unknown;
    try {
      harness = await ProductionFullSliceHarness.create(postgres, "S7", "codex");
      const observed = await harness.run();
      const interveneAcks = observed.publicAcks.filter(
        (ack) => ack.operation === "intervene",
      );
      const deliveryId = interveneAcks[0]?.deliveryId ?? "";

      expect(interveneAcks).toHaveLength(1);
      expect(interveneAcks[0]).toMatchObject({
        status: 200,
        body: {
          type: "intervene_ack",
          status: "ok",
          outcome: "auto_resumed",
        },
        deliveryId: expect.any(String),
      });
      expect(observed.engineBoundaryProbes).toContainEqual(expect.objectContaining({
        call: "executeFrames",
        scenario: "S7",
        backend: "codex",
        resumeSessionId: expect.any(String),
        prompt: expect.stringContaining("S7 codex completed resume"),
      }));
      expect(observed.durable.assistantContents).toContain("S7 codex resume reply");
      expect(observed.delivery).toEqual({
        rowCount: 1,
        deliveryId,
        targetSessionId: observed.sessionId,
        state: "consumed",
        aggregateState: "consumed",
        consumedAt: expect.any(String),
      });
      expect(observed.durable.status).toBe("completed");
      expect(observed.durable.sessionEndedCount).toBe(2);
      expect(observed.durable.unfinishedDeliveryCount).toBe(0);
      expect(observed.durable.ghostRunningCount).toBe(0);
    } catch (error) {
      scenarioError = error;
    }

    const cleanupErrors: unknown[] = [];
    try {
      await harness?.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await postgres.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (scenarioError) {
      throw cleanupErrors.length > 0
        ? new AggregateError(
            [scenarioError, ...cleanupErrors],
            "S7 full-slice scenario and cleanup failed",
          )
        : scenarioError;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "S7 full-slice cleanup failed");
    }
  }, 120_000);
});
