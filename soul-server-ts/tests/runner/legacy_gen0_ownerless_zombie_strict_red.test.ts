import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
} from "../db/full_schema_postgres_harness.js";
import { LegacyGen0OwnerlessZombieHarness } from
  "./legacy_gen0_ownerless_zombie_harness.js";
import { legacyGen0OwnerlessViolations } from
  "./legacy_gen0_ownerless_zombie_oracle.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("legacy gen0 ownerless zombie startup/reconnect strict RED", () => {
  let postgres: FullSchemaPostgresHarness;
  let product: LegacyGen0OwnerlessZombieHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    product = await LegacyGen0OwnerlessZombieHarness.create(postgres);
  }, 60_000);

  afterAll(async () => {
    await product?.cleanup();
    await postgres?.cleanup();
  });

  it("converges gen0 without an ownership row while preserving all three controls", async () => {
    const observation = await product.observeStartupReconnectMatrix();
    const violations = legacyGen0OwnerlessViolations(observation);
    console.info(
      "[legacy-gen0 ownerless strict RED]",
      JSON.stringify({ observation, violations }),
    );
    expect(violations).toEqual([]);
  });
});
