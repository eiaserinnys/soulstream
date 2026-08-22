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

import { createQueryRunner } from "./fault-harness-database.mjs";
import {
  reportMutationGate,
  runMutationGate,
} from "./fault-harness-mutation.mjs";

/** Stands in for a built release; the gate only compares it to a receipt. */
const FIXTURE_MANIFEST = Object.freeze({
  manifestId: "sha256-ci-fixture-manifest",
  releaseCohortId: "sha256-ci-fixture-cohort",
  sourceCommit: "ci-fixture-commit",
});

async function main() {
  // A lab shell exports LAB_POSTGRES_*, and this gate writes. Running it there
  // once put a fixture row into the live lab database because the connection
  // silently preferred the lab's name over the one it was handed. Refusing
  // outright is cheaper than trusting the next reader to notice.
  if (process.env.LAB_POSTGRES_CONTAINER) {
    throw new Error(
      "refusing to run: LAB_POSTGRES_CONTAINER is set, so this shell can reach the"
      + " live lab. This gate plants rows and belongs on a throwaway database"
      + " (unset the LAB_POSTGRES_* variables, or run fault-harness.sh mutation instead).",
    );
  }
  const query = createQueryRunner(process.env);
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
  const results = await runMutationGate(target);
  const passed = reportMutationGate(results);
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
