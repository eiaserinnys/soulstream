import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
} from "./full_schema_postgres_harness.js";
import {
  BSecondWriterProductHarness,
  LIVE_IDENTITY,
  makeLiveRegistration,
  makeOwnerNullTask,
  secondWriterViolations,
} from "./v1_owner_backfill_second_writer_strict_red_harness.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("V1 owner-null legacy second-writer strict RED", () => {
  let postgres: FullSchemaPostgresHarness;
  let product: BSecondWriterProductHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    product = await BSecondWriterProductHarness.create(postgres);
  }, 60_000);

  afterAll(async () => {
    await product?.cleanup();
    await postgres?.cleanup();
  });

  it("accepts the canonical-only ideal observation", () => {
    expect(secondWriterViolations({
      status: "running",
      terminationReason: null,
      terminationDetail: null,
      sessionGeneration: 1,
      manifestId: LIVE_IDENTITY.manifestId,
      runtimeEnvIdentity: LIVE_IDENTITY.runtimeEnvIdentity,
      registrationId: LIVE_IDENTITY.registrationId,
      pid: LIVE_IDENTITY.pid,
      startIdentity: LIVE_IDENTITY.startIdentity,
      executionCommandId: LIVE_IDENTITY.executionCommandId,
      legacyActive: 0,
    })).toEqual([]);
  });

  it("keeps the first live scan ownership-durable-free and undecided", async () => {
    const sessionId = "b-red-first-scan";
    await product.resetRunningSession(sessionId);
    const task = makeOwnerNullTask(sessionId);
    const reconciler = product.createLiveReconciler(
      task,
      makeLiveRegistration(sessionId),
      product.createRecovery(),
    );

    await expect(reconciler.reconcile()).resolves.toBe("wait");
    expect(await product.snapshot(sessionId)).toMatchObject({
      status: "running",
      sessionGeneration: 0,
      manifestId: null,
      legacyActive: 0,
    });
  });

  it("B_SECOND_WRITER_RED rejects the legacy active owner created by the live path", async () => {
    const sessionId = "b-red-live";
    await product.resetRunningSession(sessionId);
    const task = makeOwnerNullTask(sessionId);
    const reconciler = product.createLiveReconciler(
      task,
      makeLiveRegistration(sessionId),
      product.createRecovery(),
    );

    await reconciler.reconcile();
    reconciler.advance();
    await expect(reconciler.reconcile()).resolves.toBe("proceed");

    const snapshot = await product.snapshot(sessionId);
    const violations = secondWriterViolations(snapshot);
    if (violations.length > 0) throw new Error(violations.join("\n"));
    expect(snapshot).toMatchObject({
      status: "running",
      sessionGeneration: 1,
      manifestId: LIVE_IDENTITY.manifestId,
      runtimeEnvIdentity: LIVE_IDENTITY.runtimeEnvIdentity,
      registrationId: LIVE_IDENTITY.registrationId,
      pid: LIVE_IDENTITY.pid,
      startIdentity: LIVE_IDENTITY.startIdentity,
      executionCommandId: LIVE_IDENTITY.executionCommandId,
      legacyActive: 0,
    });
  });

  it("converges an absent owner-null session without creating a legacy owner", async () => {
    const sessionId = "b-red-absent";
    await product.resetRunningSession(sessionId);
    const task = makeOwnerNullTask(sessionId);
    const reconciler = product.createAbsentReconciler(task, product.createRecovery());

    await reconciler.reconcile();
    expect(await product.snapshot(sessionId)).toMatchObject({
      status: "running",
      sessionGeneration: 0,
      legacyActive: 0,
    });
    reconciler.advance();
    await reconciler.reconcile();

    expect(await product.snapshot(sessionId)).toMatchObject({
      status: "interrupted",
      terminationReason: "unknown",
      terminationDetail:
        "owner-null running migration could not prove a stable runner identity",
      sessionGeneration: 0,
      legacyActive: 0,
    });
  });

  it("keeps old-soul base and v2 backfill ABI available to a new orch drain", async () => {
    const cases = [
      { sessionId: "b-red-rolling-base", hash: "a".repeat(64) },
      {
        sessionId: "b-red-rolling-v2",
        runtimeEnvIdentity: LIVE_IDENTITY.runtimeEnvIdentity,
        hash: "b".repeat(64),
      },
    ] as const;

    for (const item of cases) {
      await product.resetRunningSession(item.sessionId);
      const application = await product.publishOldSoulBackfill(item.sessionId, {
        ...("runtimeEnvIdentity" in item
          ? { runtimeEnvIdentity: item.runtimeEnvIdentity }
          : {}),
        evidenceHash: item.hash,
      });
      expect(application.applied).toBe(true);
      expect(await product.snapshot(item.sessionId)).toMatchObject({
        status: "running",
        sessionGeneration: 0,
        manifestId: null,
        legacyActive: 1,
      });
    }
  });
});
