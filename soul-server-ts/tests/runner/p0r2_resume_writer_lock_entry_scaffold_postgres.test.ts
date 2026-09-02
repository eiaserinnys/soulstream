import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import { P0R2FullSliceHarness } from
  "./p0r2_resume_writer_lock_full_slice_harness.js";

describe("P0-R2 real boundary entry scaffold", () => {
  let postgres: FullSchemaPostgresHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => {
    await postgres.cleanup();
  });

  it("enters spawn, registration, execution, persistence, and finalization", async () => {
    const harness = await P0R2FullSliceHarness.create(postgres);
    try {
      const observed = await harness.runEntryScaffold();

      expect(observed.firstExecution.pid).toBeGreaterThan(0);
      expect(observed.persistedInitialReplyCount).toBe(1);
      expect(observed.sessionStatus).toBe("completed");
      expect(observed.registrationCleared).toBe(true);
      expect(observed.registrationRecordCount).toBe(1);
      expect(observed.taskStatus).toBe("completed");
      expect(observed.runnerAttached).toBe(false);
      expect(observed.executionPromiseAttached).toBe(false);
      expect(observed.pumpErrors).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  }, 45_000);
});
