import assert from "node:assert/strict";
import test from "node:test";

import { defineHarnessBoundary } from "./fault-harness-boundary.mjs";
import {
  boundaryContractInventory,
  runBoundaryContracts,
} from "./fault-harness-contracts.mjs";

test("every discovered boundary contract holds", async () => {
  const results = await runBoundaryContracts();
  const broken = results.filter((result) => result.outcome !== "held");
  assert.deepEqual(
    broken.map((result) => `${result.name}: ${result.detail}`),
    [],
  );
  const inventory = await boundaryContractInventory();
  assert.equal(results.length, inventory.length);
  assert.ok(results.length > 0);
});

test("a wiring cannot be constructed without its inline contract", () => {
  assert.throws(
    () => defineHarnessBoundary({
      name: "uncontracted_wiring",
      what: "this deliberately omits the proof required by the only boundary constructor",
      async implementation() {},
    }),
    /requires an inline contract/,
  );
});

test("the discovered registry is self-describing and duplicate-free", async () => {
  const inventory = await boundaryContractInventory();
  const names = inventory.map((contract) => contract.name);
  assert.equal(new Set(names).size, names.length);
  for (const contract of inventory) {
    assert.ok(contract.what.length > 20, `${contract.name} has no description`);
    assert.equal(typeof contract.check, "function");
  }
});
