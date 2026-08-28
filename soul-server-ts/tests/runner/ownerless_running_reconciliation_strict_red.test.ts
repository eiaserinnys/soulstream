import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
} from "../db/full_schema_postgres_harness.js";
import { OwnerlessRunningProductHarness } from
  "./ownerless_running_reconciliation_harness.js";
import {
  absentConvergenceViolations,
  acquireRaceViolations,
  classificationViolations,
  compatibleLiveViolations,
  explicitResumeViolations,
  failureRetryViolations,
  idealOwnerlessMatrix,
  matrixViolations,
} from "./ownerless_running_reconciliation_oracle.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("ownerless running two-scan reconciliation strict RED", () => {
  let postgres: FullSchemaPostgresHarness;
  let product: OwnerlessRunningProductHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    product = await OwnerlessRunningProductHarness.create(postgres);
  }, 60_000);

  afterAll(async () => {
    await product?.cleanup();
    await postgres?.cleanup();
  });

  it("has one zero-violation ideal for all six named rows", () => {
    expect(matrixViolations(idealOwnerlessMatrix())).toEqual({
      row1: [],
      row2: [],
      row3: [],
      row4: [],
      row5: [],
      row6: [],
    });
  });

  it("row 1: generation-0 absent registration writes nothing on scan 1 and terminalizes once on stable scan 2", async () => {
    const observation = await product.observeAbsentConvergence();
    assertRow(1, observation, absentConvergenceViolations(observation));
  });

  it("row 2: acquire between scan-2 proof and terminal commit wins the generation CAS", async () => {
    const observation = await product.observeAcquireBetweenProofAndCommit();
    assertRow(2, observation, acquireRaceViolations(observation));
  });

  it("row 3: compatible live registration adopts once and retains the same generation and identity", async () => {
    const observation = await product.observeCompatibleLiveRegistration();
    assertRow(3, observation, compatibleLiveViolations(observation));
  });

  it("row 4: explicit resume acquires exactly one new generation without a false terminal", async () => {
    const observation = await product.observeExplicitResume();
    assertRow(4, observation, explicitResumeViolations(observation));
  });

  it("row 5: user stop and persistence failure preserve evidence, retryability, and one finalizer", async () => {
    const observation = await product.observeFailureRetryAndUserStop();
    assertRow(5, observation, failureRetryViolations(observation));
  });

  it("row 6: absent, live, stalled, and incompatible are MECE and catalog cannot mask DB status", async () => {
    const observation = await product.observeClassificationAndCatalog();
    assertRow(6, observation, classificationViolations(observation));
  });
});

function assertRow(row: number, observation: unknown, violations: string[]): void {
  console.info(
    `[ownerless-running strict RED row ${row}]`,
    JSON.stringify({ observation, violations }),
  );
  expect(violations).toEqual([]);
}
