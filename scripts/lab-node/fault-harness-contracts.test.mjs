import assert from "node:assert/strict";
import test from "node:test";

import {
  BOUNDARY_CONTRACTS,
  runBoundaryContracts,
} from "./fault-harness-contracts.mjs";

// Runs in CI, where there is no lab and no database. These drive the real
// sampler and the real replay across the real seams, so cutting any of the
// wirings they cover fails here rather than three reviews later.

test("every boundary contract holds", async () => {
  const results = await runBoundaryContracts();
  const broken = results.filter((result) => result.outcome !== "held");
  assert.deepEqual(
    broken.map((result) => `${result.name}: ${result.detail}`),
    [],
  );
  assert.equal(results.length, BOUNDARY_CONTRACTS.length);
});

test("the boundary set covers each wiring added after the mutation gate", () => {
  // A fixed list of row-plantings cannot grow when the harness grows: the
  // pending wiring, the replay clock and the marker check were all added after
  // the mutation gate existed, and all three sat outside it. Naming them here
  // makes a silent removal fail rather than pass.
  assert.deepEqual(BOUNDARY_CONTRACTS.map((contract) => contract.name).sort(), [
    "pending_blocks_the_settle_loop",
    "pending_reaches_the_snapshot",
    "replay_uses_the_capture_clock",
  ]);
});

test("each contract states what breaks, not just that something did", () => {
  for (const contract of BOUNDARY_CONTRACTS) {
    assert.ok(contract.what.length > 20, `${contract.name} has no description`);
    assert.equal(typeof contract.check, "function");
  }
});
