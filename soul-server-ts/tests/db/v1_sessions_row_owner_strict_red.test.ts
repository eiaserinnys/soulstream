import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";
import {
  V1_OWNER_MUTATIONS,
  type V1OwnerMutation,
} from "./v1_sessions_row_owner_contract.js";
import { createCounterfactualBoundary } from "./v1_sessions_row_owner_harness.js";
import { createCurrentProductBoundary } from
  "./v1_sessions_row_owner_product_adapter.js";
import {
  observeV1Contract,
  V1_MUTATION_SENTINELS,
  type V1ContractAxis,
  type V1ContractObservation,
} from "./v1_sessions_row_owner_scenarios.js";

const AXES: readonly V1ContractAxis[] = ["competition", "identity", "release"];

describe("V1 sessions-row owner strict RED", () => {
  let harness: FullSchemaPostgresHarness;
  let product: V1ContractObservation;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    product = await observeV1Contract(
      createCurrentProductBoundary(harness),
      "v1-product-red",
    );
  }, 45_000);

  afterAll(async () => await harness.cleanup());

  it("same-harness counterfactual GREEN reaches all three axes", async () => {
    const observation = await observeV1Contract(
      await createCounterfactualBoundary(harness),
      "v1-counterfactual",
    );
    const violations = flattenViolations(observation);
    process.stderr.write(
      `V1_COUNTERFACTUAL_GREEN ${JSON.stringify({ violations, observation })}\n`,
    );
    expect(violations).toEqual([]);
  });

  it.each(V1_OWNER_MUTATIONS)(
    "same-harness mutation %s is detected by a live boundary call",
    async (mutation) => {
      const observation = await observeV1Contract(
        await createCounterfactualBoundary(harness, mutation),
        `v1-mutation-${mutation}`,
      );
      const violations = flattenViolations(observation);
      process.stderr.write(
        `V1_MUTATION_RED ${mutation} ${JSON.stringify({ violations, observation })}\n`,
      );
      expect(violations).toContain(V1_MUTATION_SENTINELS[mutation]);
    },
  );

  it.each(AXES)("origin/main strict RED: %s", (axis) => {
    const observed = product[axis];
    process.stderr.write(
      `V1_PRODUCT_RED ${axis} ${JSON.stringify(observed)}\n`,
    );
    expect(
      observed.violations,
      `${axis} violations: ${JSON.stringify(observed.violations)}`,
    ).toEqual([]);
  });
});

function flattenViolations(observation: V1ContractObservation): string[] {
  return AXES.flatMap((axis) => observation[axis].violations);
}

// Keep the mutation map total when a new mutation is added.
const _mutationInventory: Record<V1OwnerMutation, string> = V1_MUTATION_SENTINELS;
void _mutationInventory;
