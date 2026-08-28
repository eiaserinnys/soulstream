import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
} from "../db/full_schema_postgres_harness.js";
import { OwnerlessStaleTerminalFanoutHarness } from
  "./ownerless_stale_terminal_fanout_harness.js";
import {
  appliedTerminalFanoutViolations,
  idealStaleTerminalFanout,
  staleTerminalFanoutViolations,
} from "./ownerless_stale_terminal_fanout_oracle.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("ownerless acquire-winner stale terminal semantic fanout strict RED", () => {
  let postgres: FullSchemaPostgresHarness;
  let product: OwnerlessStaleTerminalFanoutHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    product = new OwnerlessStaleTerminalFanoutHarness(postgres);
  }, 60_000);

  afterAll(async () => {
    await postgres?.cleanup();
  });

  it("has one zero-violation stale terminal fanout ideal", () => {
    expect(staleTerminalFanoutViolations(idealStaleTerminalFanout())).toEqual([]);
  });

  it("rejects the stale terminal effect without semantic fanout and continues on the acquire winner", async () => {
    const observation = await product.observeRejectedStaleTerminal();
    const violations = staleTerminalFanoutViolations(observation);
    console.info(
      "[ownerless stale terminal fanout strict RED]",
      JSON.stringify({ observation, violations }),
    );
    expect(violations).toEqual([]);
  });

  it("retains exactly-once semantic fanout for an applied terminal effect", async () => {
    const observation = await product.observeAppliedTerminal();
    const violations = appliedTerminalFanoutViolations(observation);
    console.info(
      "[ownerless applied terminal fanout control]",
      JSON.stringify({ observation, violations }),
    );
    expect(violations).toEqual([]);
  });
});
