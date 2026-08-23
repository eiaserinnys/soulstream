#!/usr/bin/env node
/**
 * Runs the real mutation gate against a throwaway database, with no lab.
 *
 * This is the piece that was missing, and it is the one that matters most.
 *
 * The audit's headline finding was an invariant whose input was a function
 * parameter -- the query that should have filled it did not exist. Unit tests
 * over hand-built snapshots passed the whole time, because they only ever
 * checked the mapping from a snapshot to a verdict, never that a snapshot can
 * be built from a database that actually contains a violation. The independent
 * review then blanked all seven snapshot-producing queries and showed the CI
 * suite still reported 37/37 green while the live gate correctly failed 0/8.
 *
 * A regression guard that cannot catch the regression it was written for is
 * the same class of object as the judge it was guarding. So the gate runs
 * here too: postgres from a service container, `schema.sql` applied straight
 * in, a fixture manifest and a temporary runner-state directory standing in
 * for the lab's, and then the same `runMutationGate` the lab node runs.
 *
 * Expects PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE in the environment.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reportBoundaryContracts,
  runBoundaryContracts,
} from "./fault-harness-contracts.mjs";
import { createQueryRunner } from "./fault-harness-database.mjs";
import {
  reportMutationGate,
  runMutationGate,
} from "./fault-harness-mutation.mjs";
import { assertThrowawayTarget } from "./fault-harness-throwaway-boundary.mjs";

/** Stands in for a built release; the gate only compares it to a receipt. */
const FIXTURE_MANIFEST = Object.freeze({
  manifestId: "sha256-ci-fixture-manifest",
  releaseCohortId: "sha256-ci-fixture-cohort",
  sourceCommit: "ci-fixture-commit",
});

/**
 * The database must prove it is disposable before anything is written to it.
 *
 * The first guard refused when `LAB_POSTGRES_CONTAINER` was set -- a denylist,
 * and denylists are satisfied by unsetting one variable. Unset it, point
 * `PGDATABASE` at the live lab, and the guard waves the gate through to plant
 * rows in production data. That is the exact accident this file already caused
 * once, so "is not obviously the lab" is not a good enough answer.
 *
 * So the requirement is positive and unforgeable by omission: the target must
 * contain a marker table this gate did not create, carrying the expected
 * token. Creating it is a deliberate act -- one line in the CI workflow next
 * to the throwaway database it applies to -- and no live database has it.
 */
async function main() {
  const query = createQueryRunner(process.env);
  await assertThrowawayTarget(query);
  const runnerStateDirectory = await mkdtemp(join(tmpdir(), "lab-harness-ci-"));

  // The gate's activation mutation works by making the newest receipt disagree
  // with the running release, so there has to be an agreeing one to start
  // from. Without it the invariant is already firing on an empty table and the
  // mutation can only report inconclusive.
  await query(`
    WITH seeded AS (
      INSERT INTO node_release_activation_receipts (
        node_id, manifest_id, release_cohort_id, source_commit,
        prewarmed_at, activated_at, verification, registration_idempotency_key
      ) VALUES (
        'eias-lab', '${FIXTURE_MANIFEST.manifestId}', '${FIXTURE_MANIFEST.releaseCohortId}',
        '${FIXTURE_MANIFEST.sourceCommit}', NOW(), NOW(),
        jsonb_build_object('host','verified','runner','verified','env','verified','executable','verified'),
        'ci-fixture-receipt'
      ) ON CONFLICT DO NOTHING RETURNING 1
    ) SELECT json_build_object('rows', (SELECT COUNT(*) FROM seeded))
  `);

  const target = {
    psqlOne: query,
    runnerStateDirectory,
    async currentManifest() { return FIXTURE_MANIFEST; },
  };
  // Boundaries first, and unconditionally.
  //
  // They need no database, so a failure here is never confounded by one, and
  // they cover the wiring the row-planting mutations structurally cannot see.
  process.stdout.write("boundary contracts:\n");
  const contracts = await runBoundaryContracts();
  const boundariesHeld = reportBoundaryContracts(contracts);

  process.stdout.write("\ninvariant mutations:\n");
  const results = await runMutationGate(target);
  const passed = reportMutationGate(results) && boundariesHeld;
  if (!boundariesHeld) {
    process.stdout.write(
      "\nA boundary between two modules has come apart. The judges may still\n"
      + "see a row planted in front of them and report nothing, because what\n"
      + "carries their answer to the verdict is broken rather than the judge.\n",
    );
  }
  if (!passed) {
    process.stdout.write(
      "\nThe judges did not see a violation planted directly in front of them.\n"
      + "That is the failure this job exists for: the snapshot queries and the\n"
      + "verdict have come apart, and every green from this harness is worthless\n"
      + "until they are joined again.\n",
    );
  }
  await writeFile(join(runnerStateDirectory, ".gate-ran"), "", { mode: 0o600 });
  return passed;
}

process.exitCode = (await main()) ? 0 : 1;
