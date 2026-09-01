import { describe, expect, it } from "vitest";

import { createFullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import { ProductionFullSliceHarness } from
  "./s4_new_session_full_slice_harness.js";

describe("R26 resumed terminal wiring production full slice", () => {
  it("finalizes and relays completion after an auto-resumed turn", async () => {
    const postgres = await createFullSchemaPostgresHarness();
    let harness: ProductionFullSliceHarness | null = null;
    let scenarioError: unknown;
    try {
      harness = await ProductionFullSliceHarness.create(postgres, "S8", "codex");
      const observed = await harness.run();

      expect(observed.durable.assistantContents).toEqual([
        "S8 codex initial reply",
        "S8 codex resume reply",
      ]);
      expect.soft(observed.durable.sessionEndedCount).toBe(2);
      expect.soft(observed.durable.status).toBe("completed");
      expect.soft(observed.durable.completionNotificationCount).toBe(2);
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
            "R26 full-slice scenario and cleanup failed",
          )
        : scenarioError;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "R26 full-slice cleanup failed");
    }
  }, 120_000);
});
