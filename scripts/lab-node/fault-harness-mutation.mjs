#!/usr/bin/env node
/**
 * Plants a violation for every judge and requires the judge to name it.
 *
 * This exists because the harness shipped an invariant, `user_message_loss`,
 * that read a parameter every caller set to `[]`. It could not fire. Nobody
 * noticed for as long as it existed, because nothing ever asked it to. Unit
 * tests over a hand-built snapshot would not have noticed either: they prove
 * the *mapping* from snapshot to verdict, not that the query behind the
 * snapshot can see a violation sitting in the database.
 *
 * So each mutation writes a real violating row into the lab database (or a
 * real lifecycle file onto disk), runs the real sampler, and requires the
 * named invariant to appear. Three phases, all required:
 *
 *   1. baseline  -- the invariant must be absent, or "red" proves nothing
 *   2. injected  -- the invariant must appear, naming the planted row
 *   3. reverted  -- the invariant must be absent again, or the harness has
 *                   been left dirty and every later run is suspect
 *
 * Every planted row is prefixed `lab-mutation-` so a leak is greppable.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sampleInvariants } from "./fault-harness-evidence.mjs";
import { LabRuntime } from "./fault-harness-runtime.mjs";

const PREFIX = "lab-mutation";

/** Windows the sampler far enough back to include rows planted just now. */
function samplingWindow() {
  return new Date(Date.now() - 10 * 60_000).toISOString();
}

const MUTATIONS = [
  {
    invariant: "unanswered_demand",
    what: "a completed session whose only user message was never answered",
    identity: (planted) => planted.sessionId,
    async inject(context) {
      const sessionId = context.id("unanswered");
      await context.sql(`
        INSERT INTO sessions (session_id, status, node_id, session_type, created_at, updated_at)
        VALUES ('${sessionId}', 'completed', 'eias-lab', 'claude', NOW(), NOW())
      `);
      await context.sql(`
        INSERT INTO events (session_id, id, event_type, payload, created_at)
        VALUES ('${sessionId}', 1, 'user_message',
          '{"type":"user_message","text":"lab mutation: answer me"}'::jsonb,
          NOW() - INTERVAL '5 minutes')
      `);
      return { sessionId };
    },
    async revert(context, planted) {
      await context.sql(`DELETE FROM sessions WHERE session_id = '${planted.sessionId}'`);
    },
  },
  {
    invariant: "unanswered_demand",
    what: "an intervention recorded but never projected, with a later reply present",
    identity: (planted) => planted.sessionId,
    async inject(context) {
      // The exact shape of the losses this audit found: a reply exists and is
      // newer than every input, so an extremal comparison reads clean.
      const sessionId = context.id("covered");
      await context.sql(`
        INSERT INTO sessions (session_id, status, node_id, session_type, created_at, updated_at)
        VALUES ('${sessionId}', 'completed', 'eias-lab', 'claude', NOW(), NOW())
      `);
      await context.sql(`
        INSERT INTO events (session_id, id, event_type, payload, created_at) VALUES
          ('${sessionId}', 1, 'user_message',
            '{"type":"user_message","text":"lab mutation: first turn"}'::jsonb,
            NOW() - INTERVAL '5 minutes'),
          ('${sessionId}', 2, 'intervention_sent',
            '{"type":"intervention_sent","text":"lab mutation: steer"}'::jsonb,
            NOW() - INTERVAL '4 minutes'),
          ('${sessionId}', 3, 'assistant_message',
            '{"type":"assistant_message","content":"lab mutation: reply"}'::jsonb,
            NOW() - INTERVAL '3 minutes'),
          ('${sessionId}', 4, 'session_ended',
            '{"type":"session_ended","status":"completed","termination_reason":"completed_ok"}'::jsonb,
            NOW() - INTERVAL '3 minutes')
      `);
      return { sessionId };
    },
    async revert(context, planted) {
      await context.sql(`DELETE FROM sessions WHERE session_id = '${planted.sessionId}'`);
    },
  },
  {
    invariant: "ownerless_running",
    what: "a running session with no open execution ownership",
    identity: (planted) => planted.sessionId,
    async inject(context) {
      const sessionId = context.id("ownerless");
      await context.sql(`
        INSERT INTO sessions (session_id, status, node_id, session_type, created_at, updated_at)
        VALUES ('${sessionId}', 'running', 'eias-lab', 'claude', NOW(), NOW())
      `);
      return { sessionId };
    },
    async revert(context, planted) {
      await context.sql(`DELETE FROM sessions WHERE session_id = '${planted.sessionId}'`);
    },
  },
  {
    invariant: "runner_terminal_projection",
    what: "a runner lifecycle that finished while central state still says running",
    identity: (planted) => planted.sessionId,
    async inject(context) {
      const sessionId = context.id("projection");
      await context.sql(`
        INSERT INTO sessions (session_id, status, node_id, session_type, created_at, updated_at)
        VALUES ('${sessionId}', 'running', 'eias-lab', 'claude', NOW(), NOW())
      `);
      // An open ownership, so this row is a projection mismatch and *only*
      // that. Without it the session is also ownerless-running, both judges
      // fire, and a green from the mutation would not say which one saw it.
      await context.sql(`
        INSERT INTO session_execution_ownerships (
          session_id, ownership_generation, owner_kind, manifest_id, phase,
          reserved_at, reservation_expires_at
        ) VALUES (
          '${sessionId}', 1, 'runner_process', 'sha256-${PREFIX}-manifest',
          'reserved', NOW(), NOW() + INTERVAL '10 minutes'
        )
      `);
      const directory = join(context.runtime.runnerStateDirectory, `${PREFIX}-projection`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, "runner-lifecycle.json"),
        JSON.stringify({
          session_id: sessionId,
          execution_state: "completed",
          progress_at: new Date(Date.now() - 600_000).toISOString(),
        }),
        { mode: 0o600 },
      );
      return { sessionId, directory };
    },
    async revert(context, planted) {
      await rm(planted.directory, { recursive: true, force: true });
      await context.sql(`DELETE FROM sessions WHERE session_id = '${planted.sessionId}'`);
    },
  },
  {
    invariant: "overdue_retry",
    what: "a pending delivery whose retry clock went by without an attempt",
    identity: (planted) => planted.deliveryId,
    async inject(context) {
      const deliveryId = context.id("overdue");
      await context.insertDelivery(deliveryId, {
        state: "pending",
        aggregateState: "pending",
        extraColumns: ", next_attempt_at",
        extraValues: ", NOW() - INTERVAL '1 minute'",
      });
      return { deliveryId };
    },
    async revert(context, planted) {
      await context.sql(`DELETE FROM session_deliveries WHERE delivery_id = '${planted.deliveryId}'`);
    },
  },
  {
    invariant: "ambiguous_uncertain",
    what: "a delivery left uncertain without being dead-lettered",
    identity: (planted) => planted.deliveryId,
    async inject(context) {
      const deliveryId = context.id("uncertain");
      await context.insertDelivery(deliveryId, {
        state: "uncertain",
        aggregateState: "pending",
      });
      return { deliveryId };
    },
    async revert(context, planted) {
      await context.sql(`DELETE FROM session_deliveries WHERE delivery_id = '${planted.deliveryId}'`);
    },
  },
  {
    invariant: "reasonless_dead_letter",
    what: "a dead letter with no reason recorded",
    identity: (planted) => planted.deliveryId,
    async inject(context) {
      const deliveryId = context.id("reasonless");
      await context.insertDelivery(deliveryId, {
        state: "delivered",
        aggregateState: "dead_letter",
      });
      return { deliveryId };
    },
    async revert(context, planted) {
      await context.sql(`DELETE FROM session_deliveries WHERE delivery_id = '${planted.deliveryId}'`);
    },
  },
  {
    invariant: "activation_manifest",
    what: "the newest activation receipt naming a release the host is not running",
    async inject(context) {
      const key = context.id("activation");
      await context.sql(`
        INSERT INTO node_release_activation_receipts (
          node_id, manifest_id, release_cohort_id,
          source_commit, prewarmed_at, activated_at, verification,
          registration_idempotency_key
        )
        VALUES ('eias-lab',
          'sha256-${PREFIX}-not-the-running-release', 'sha256-${PREFIX}-cohort',
          '${PREFIX}-commit', NOW(), NOW(), jsonb_build_object('host','verified','runner','verified','env','verified','executable','verified'), '${key}')
      `);
      return { key };
    },
    async revert(context, planted) {
      await context.sql(`
        DELETE FROM node_release_activation_receipts
        WHERE registration_idempotency_key = '${planted.key}'
      `);
    },
  },
];

/**
 * The invariants the mutation gate plants a violation for.
 *
 * Exported so a test can require it to cover every invariant the verdict can
 * emit. A judge added without a mutation is a judge nobody has ever seen go
 * red, which is how the last one got here.
 */
export const MUTATION_COVERAGE = Object.freeze(
  [...new Set(MUTATIONS.map((mutation) => mutation.invariant))],
);

/**
 * Seven judges, eight mutations.
 *
 * `unanswered_demand` gets two because it has two distinct failure shapes --
 * an input with no reply at all, and an input covered by a later reply. The
 * earlier reporting said "8 판정기", conflating mutations with judges and
 * overstating coverage by one. Counting the wrong thing is how this whole
 * audit started.
 */
export const JUDGE_COUNT = MUTATION_COVERAGE.length;

/**
 * Whether `violations` name the exact row this mutation planted.
 *
 * Identity, not presence. Presence was not good enough: run the gate right
 * after a fault run and `unanswered_demand` is already firing on real losses,
 * so "the invariant appeared" proves nothing and the mutation reports
 * inconclusive -- honest, but useless exactly when you most want the answer.
 * Asking for the planted id instead works against a dirty lab and cannot be
 * satisfied by somebody else's violation.
 *
 * Count-only invariants name nothing to match, so they fall back to presence
 * and must start from a clean baseline.
 */
function namesPlanted(violations, invariantName, identity) {
  const violation = violations.find((entry) => entry.invariant === invariantName);
  if (!violation) return false;
  if (identity === undefined) return true;
  return (violation.examples ?? []).some(
    (example) => JSON.stringify(example).includes(identity),
  );
}

async function runMutation(mutation, context, index) {
  const before = await context.sample();
  let planted;
  let detected = false;
  let collateral = [];
  try {
    planted = await mutation.inject(context);
    const identity = mutation.identity?.(planted);
    if (identity === undefined && namesPlanted(before, mutation.invariant, undefined)) {
      return {
        invariant: mutation.invariant,
        what: mutation.what,
        outcome: "inconclusive",
        detail: "count-only invariant was already firing before the mutation was planted",
      };
    }
    const injected = await context.sample();
    detected = namesPlanted(injected, mutation.invariant, identity);
    if (!detected) {
      return {
        invariant: mutation.invariant,
        what: mutation.what,
        outcome: "NOT DETECTED",
        detail: `planted ${JSON.stringify(planted)} and the judge did not name it`,
      };
    }
    // Which *other* judges also named this row.
    //
    // A mutation that trips three judges does not prove any one of them
    // works -- it proves the planted row is ambiguous, and a green from it
    // means less than it looks. Reported rather than failed, because some
    // overlap is real: a session that is running with no owner genuinely is
    // both ownerless and, once a finished lifecycle sits beside it, a
    // projection mismatch.
    collateral = identity === undefined ? [] : injected
      .filter((entry) => entry.invariant !== mutation.invariant)
      .filter((entry) => (entry.examples ?? []).some(
        (example) => JSON.stringify(example).includes(identity),
      ))
      .map((entry) => entry.invariant);
  } finally {
    if (planted) await mutation.revert(context, planted);
  }
  const after = await context.sample();
  if (namesPlanted(after, mutation.invariant, mutation.identity?.(planted))) {
    return {
      invariant: mutation.invariant,
      what: mutation.what,
      outcome: "DIRTY",
      detail: "the judge still names the planted row after it was reverted",
    };
  }
  return {
    invariant: mutation.invariant,
    what: mutation.what,
    outcome: "detected",
    collateral,
    index,
  };
}

export async function runMutationGate(runtime) {
  const since = samplingWindow();
  let counter = 0;
  const context = {
    runtime,
    id: (kind) => `${PREFIX}-${kind}-${Date.now().toString(36)}-${(counter += 1)}`,
    sql: (query) => runtime.psqlOne(`WITH mutation AS (${query} RETURNING 1)
      SELECT json_build_object('rows', (SELECT COUNT(*) FROM mutation))`),
    async insertDelivery(deliveryId, options) {
      await runtime.psqlOne(`
        WITH mutation AS (
          INSERT INTO session_deliveries (
            delivery_id, relation_key, intent, source,
            payload_hash, state, aggregate_state, created_at${options.extraColumns ?? ""}
          ) VALUES (
            '${deliveryId}',
            '${deliveryId}-relation', 'completion_notification', '${PREFIX}',
            '${PREFIX}-hash', '${options.state}', '${options.aggregateState}',
            NOW()${options.extraValues ?? ""}
          ) RETURNING 1
        ) SELECT json_build_object('rows', (SELECT COUNT(*) FROM mutation))
      `);
    },
    async sample() {
      const { violations } = await sampleInvariants(runtime, since);
      return violations;
    },
  };
  const results = [];
  try {
    for (const [index, mutation] of MUTATIONS.entries()) {
      results.push(await runMutation(mutation, context, index));
    }
  } finally {
    // Per-mutation revert only runs when `inject` got far enough to return.
    // An injection that fails halfway -- session written, events rejected --
    // would otherwise leave a row behind and quietly poison every later run,
    // which is the failure mode this whole gate exists to prevent. Everything
    // planted carries the prefix, so one sweep collects all of it.
    const residue = await sweepResidue(runtime);
    if (residue > 0) {
      results.push({
        invariant: "(cleanup)",
        what: `${residue} planted row(s) survived their own revert and were swept`,
        outcome: "DIRTY",
      });
    }
  }
  return results;
}

/** Removes anything the gate planted, and reports how much there was. */
async function sweepResidue(runtime) {
  const swept = await runtime.psqlOne(`
    WITH removed_sessions AS (
      DELETE FROM sessions WHERE session_id LIKE '${PREFIX}-%' RETURNING 1
    ), removed_deliveries AS (
      DELETE FROM session_deliveries WHERE delivery_id LIKE '${PREFIX}-%' RETURNING 1
    ), removed_receipts AS (
      DELETE FROM node_release_activation_receipts
      WHERE registration_idempotency_key LIKE '${PREFIX}-%' RETURNING 1
    )
    SELECT json_build_object('rows',
      (SELECT COUNT(*) FROM removed_sessions)
      + (SELECT COUNT(*) FROM removed_deliveries)
      + (SELECT COUNT(*) FROM removed_receipts))
  `);
  let directories = 0;
  try {
    for (const entry of await readdir(runtime.runnerStateDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
      await rm(join(runtime.runnerStateDirectory, entry.name), { recursive: true, force: true });
      directories += 1;
    }
  } catch {}
  return (swept?.rows ?? 0) + directories;
}

export function reportMutationGate(results) {
  for (const result of results) {
    process.stdout.write(
      `${result.outcome.padEnd(14)} ${result.invariant.padEnd(28)} ${result.what}\n`
      + (result.detail ? `               ${result.detail}\n` : "")
      + (result.collateral?.length
        ? `               also named by: ${result.collateral.join(", ")}\n`
        : ""),
    );
  }
  const failures = results.filter((result) => result.outcome !== "detected");
  process.stdout.write(
    `\n${results.length} mutation(s) over ${JUDGE_COUNT} judge(s): `
    + `${results.length - failures.length} detected, ${failures.length} not.\n`,
  );
  return failures.length === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runMutationGate(new LabRuntime());
  process.exitCode = reportMutationGate(results) ? 0 : 1;
}
