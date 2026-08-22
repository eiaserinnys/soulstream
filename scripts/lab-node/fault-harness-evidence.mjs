import {
  appendFile,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  evaluateInvariantSnapshot,
  newInvariantViolations,
  redactEvidenceLine,
} from "./fault-harness-contract.mjs";
import {
  groupEventsBySession,
  pairingInputsQuery,
} from "./fault-harness-database.mjs";
import {
  findPendingSessions,
  findUnansweredDemands,
} from "./fault-harness-verdict.mjs";

export class EvidenceRecorder {
  constructor(runtime, runId, directory) {
    this.runtime = runtime;
    this.runId = runId;
    this.directory = directory;
    // Sessions from earlier runs stay in the lab database forever. Counting
    // them makes every verdict a running total that nobody can read: "11
    // violations" says nothing about which one this run caused.
    this.since = new Date().toISOString();
    this.eventsPath = join(directory, "events.jsonl");
    this.invariantsPath = join(directory, "invariants.jsonl");
    this.pairingInputsPath = join(directory, "pairing-inputs.jsonl");
  }

  async event(action, details = {}) {
    const record = { at: new Date().toISOString(), action, details };
    await appendJsonLine(this.eventsPath, record);
    return record;
  }

  /**
   * Samples the invariants once, or waits for a post-scenario sample to settle.
   *
   * Central session state is projected asynchronously from runner state, so a
   * single sample taken seconds after a scenario ends reports whatever happened
   * to still be in flight. F1 was failed by exactly that: a session the judge
   * called dead-but-running had reached `interrupted` with both ownerships
   * terminal moments later. The contract this harness exists to defend is that
   * nothing is lost or stuck permanently -- delay is allowed -- so pass
   * `settleMs` on the after-sample and a violation only counts once it has had
   * that long to clear. Baseline samples never wait; they are the comparison.
   */
  async invariant(label, baseline = [], settleMs = 0) {
    const deadline = Date.now() + settleMs;
    const startedAt = Date.now();
    let sample = await this.sampleOnce(label, baseline);
    // A run that recovers after eighty-nine seconds and a run that was never
    // broken used to produce the same record. Waiting is the contract -- delay
    // is allowed -- but erasing the fact that something *was* broken is not,
    // because the next reader has no way to tell a healthy system from one
    // that is always one second inside the grace.
    const firstViolations = sample.newViolations;
    const firstSeenAt = firstViolations.length > 0 ? sample.sampledAt : null;
    // Unresolved `pending` keeps the loop running for the same reason a
    // violation does: the question has not been answered yet. Treating it as
    // clean is how a still-running session became evidence of health.
    while (unsettled(sample) && Date.now() < deadline) {
      await delay(5_000);
      sample = await this.sampleOnce(label, baseline);
    }
    sample.settled = !unsettled(sample);
    sample.unresolvedPending = sample.pendingSessions ?? [];
    sample.recovery = {
      firstSeenAt,
      firstSeenViolations: firstViolations.map((violation) => ({
        invariant: violation.invariant,
        count: violation.count,
      })),
      clearedAt: firstSeenAt && sample.settled ? sample.sampledAt : null,
      recoveredAfterMs: firstSeenAt && sample.settled
        ? Date.parse(sample.sampledAt) - Date.parse(firstSeenAt)
        : null,
      settleBudgetMs: settleMs,
      waitedMs: Date.now() - startedAt,
    };
    await appendJsonLine(this.invariantsPath, sample);
    return sample;
  }

  async sampleOnce(label, baseline) {
    await delay(2_000);
    const { pairingInputs, ...sample } = await sampleInvariants(this.runtime, this.since);
    sample.label = label;
    sample.since = this.since;
    sample.newViolations = newInvariantViolations(baseline, sample.violations);
    // The inputs the verdict was computed from, kept beside the verdict.
    //
    // Without this a stored run cannot be re-judged: the two directories this
    // audit was asked to re-judge could not be, because the lab database had
    // been rebuilt and the evidence carried only conclusions. Evidence that
    // cannot be re-checked is a claim, not evidence.
    //
    // Appended, not overwritten. The first version wrote one file per run and
    // rewrote it on every sample, so the settle loop erased each intermediate
    // state and a run that recovered kept no record of what it recovered from.
    await appendJsonLine(this.pairingInputsPath, {
      label,
      since: this.since,
      capturedAt: sample.sampledAt,
      ...pairingInputs,
    });
    return sample;
  }

  async scenario(id, result) {
    await writeFile(
      join(this.directory, `${safeFileName(id)}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  async logOffsets() {
    return {
      node: await fileSize(this.runtime.nodeLog),
      orch: await fileSize(this.runtime.orchLog),
    };
  }

  async captureLogs(label, offsets, terms) {
    const result = {};
    for (const [kind, path] of [["node", this.runtime.nodeLog], ["orch", this.runtime.orchLog]]) {
      const text = await readFromOffset(path, offsets[kind] ?? 0);
      const matching = text.split("\n")
        .filter((line) => line && terms.some((term) => line.includes(term)))
        .map((line) => redactEvidenceLine(line.slice(0, 4_000), this.runtime.labSecrets));
      result[kind] = matching;
      if (matching.length > 0) {
        await writeFile(
          join(this.directory, `${safeFileName(label)}-${kind}-log.jsonl`),
          `${matching.join("\n")}\n`,
          { mode: 0o600 },
        );
      }
    }
    return result;
  }

  async finish(summary) {
    const value = { runId: this.runId, completedAt: new Date().toISOString(), ...summary };
    await writeFile(
      join(this.directory, "result.json"),
      `${JSON.stringify(value, null, 2)}\n`,
      { mode: 0o600 },
    );
    return value;
  }
}

export async function sampleInvariants(runtime, since) {
  const database = await runtime.psqlOne(`
    SELECT json_build_object(
      'ownerlessRunning', (
        -- Identities, not a tally. A count cannot tell an old violation
        -- clearing from a new one arriving, and the two cancel.
        SELECT COALESCE(json_agg(json_build_object('session_id', session.session_id)), '[]'::json)
        FROM sessions AS session
        WHERE session.status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM session_execution_ownerships AS ownership
            WHERE ownership.session_id = session.session_id
              AND ownership.phase IN ('reserved', 'identity_proven', 'active')
          )
      ),
      'overdueRetries', (
        SELECT COALESCE(json_agg(json_build_object('delivery_id', delivery_id)), '[]'::json)
        FROM session_deliveries
        WHERE aggregate_state = 'pending'
          AND state = 'pending'
          AND next_attempt_at < NOW() - INTERVAL '5 seconds'
      ),
      'ambiguousUncertain', (
        SELECT COALESCE(json_agg(json_build_object('delivery_id', delivery_id)), '[]'::json)
        FROM session_deliveries
        WHERE state = 'uncertain' AND aggregate_state <> 'dead_letter'
      ),
      'reasonlessDeadLetters', (
        SELECT COALESCE(json_agg(json_build_object('delivery_id', delivery_id)), '[]'::json)
        FROM session_deliveries
        WHERE aggregate_state = 'dead_letter'
          AND NULLIF(dead_letter_reason, '') IS NULL
      ),
      'sessions', (
        SELECT COALESCE(json_agg(row_to_json(summary)), '[]'::json) FROM (
          SELECT session.session_id, session.status,
            EXISTS (
              SELECT 1 FROM session_execution_ownerships AS ownership
              WHERE ownership.session_id = session.session_id
                AND ownership.phase IN ('reserved', 'identity_proven', 'active')
            ) AS has_open_owner
          FROM sessions AS session
        ) AS summary
      ),
      'activationReceipt', (
        SELECT row_to_json(receipt) FROM (
          SELECT manifest_id, release_cohort_id, source_commit
          FROM node_release_activation_receipts
          WHERE node_id = 'eias-lab'
          ORDER BY activation_generation DESC LIMIT 1
        ) AS receipt
      )
    )
  `);
  const lifecycles = await readRunnerLifecycles(runtime.runnerStateDirectory);
  const terminalProjectionMismatches = findTerminalProjectionMismatches(
    lifecycles,
    database?.sessions ?? [],
  );
  // The user-facing verdict, derived here rather than handed in.
  //
  // What stood here before was `messageLosses`, a parameter. Every scenario
  // passed `[]` and the default was `[]`, so the one invariant built to catch
  // a lost user message could not report one no matter what the system did.
  // It is gone; this reads the event stream instead.
  const pairingInputs = await runtime.psqlOne(pairingInputsQuery(since));
  const pairedSessions = (pairingInputs?.sessions ?? []).map((session) => ({
    ...session,
    runnerProgressing: runnerIsStillWorking(lifecycles.get(session.session_id)),
  }));
  const groupedEvents = groupEventsBySession(pairingInputs?.events);
  const unansweredDemands = findUnansweredDemands(pairedSessions, groupedEvents, Date.now());
  // Sessions that may still answer.
  //
  // `pending` was added to the verdict and then never read, so a session with
  // a fresh input and a live owner produced neither a violation nor any other
  // signal and the sample came back clean. A state that nothing consumes is
  // not a state; it is a comment. The recorder waits these out below rather
  // than letting them count as health.
  const pendingSessions = findPendingSessions(pairedSessions, groupedEvents, Date.now());
  const manifest = await runtime.currentManifest();
  const receipt = database?.activationReceipt;
  const snapshot = {
    ownerlessRunning: database?.ownerlessRunning ?? [],
    unansweredDemands,
    terminalProjectionMismatches,
    overdueRetries: database?.overdueRetries ?? [],
    ambiguousUncertain: database?.ambiguousUncertain ?? [],
    reasonlessDeadLetters: database?.reasonlessDeadLetters ?? [],
    activationManifestMismatch: !receipt
      || receipt.manifest_id !== manifest.manifestId
      || receipt.release_cohort_id !== manifest.releaseCohortId
      || receipt.source_commit !== manifest.sourceCommit,
  };
  return {
    sampledAt: new Date().toISOString(),
    snapshot,
    violations: evaluateInvariantSnapshot(snapshot),
    pendingSessions,
    // P1-2 of the second review: a replay has to judge with the clock the
    // capture had. `runnerProgressing` is read from disk at sample time and is
    // gone by the time anyone re-judges, so it travels with the inputs.
    pairingInputs: pairingInputs && {
      ...pairingInputs,
      sessions: pairedSessions,
    },
  };
}

const RUNNER_TERMINAL_STATES = ["completed", "failed", "reaped", "closed"];
const RUNNER_PROGRESS_GRACE_MS = 60_000;

/** Reads every readable runner lifecycle, keyed by the session it belongs to. */
async function readRunnerLifecycles(runnerStateDirectory) {
  const lifecycles = new Map();
  let entries = [];
  try {
    entries = await readdir(runnerStateDirectory, { withFileTypes: true });
  } catch { return lifecycles; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    try {
      const lifecycle = JSON.parse(await readFile(
        join(runnerStateDirectory, entry.name, "runner-lifecycle.json"),
        "utf8",
      ));
      if (lifecycle?.session_id) lifecycles.set(lifecycle.session_id, lifecycle);
    } catch {}
  }
  return lifecycles;
}

/**
 * A runner that is still *advancing* is owed its answer; a merely breathing
 * one is not.
 *
 * `liveness_at` is refreshed for as long as a command is assigned, whether or
 * not anything is happening, so a runner blocked on a host tool response looks
 * alive forever. That is precisely the failure this harness exists to catch --
 * exempting it would leave the judge unable to see the very class of stall it
 * was strengthened for. Only `progress_at`, which moves when the runner
 * actually emits, counts as work.
 *
 * The cost is accepted: a tool that legitimately runs past the grace without
 * emitting anything gets reported. A false positive is visible and can be
 * checked; a false negative is invisible and makes every green meaningless.
 */
function runnerIsStillWorking(lifecycle) {
  if (!lifecycle) return false;
  if (RUNNER_TERMINAL_STATES.includes(lifecycle.execution_state)) return false;
  const progressedAt = Date.parse(lifecycle.progress_at ?? "") || 0;
  return Date.now() - progressedAt < RUNNER_PROGRESS_GRACE_MS;
}

function findTerminalProjectionMismatches(lifecycles, sessionRows) {
  const byId = new Map(sessionRows.map((row) => [row.session_id, row]));
  const mismatches = [];
  for (const lifecycle of lifecycles.values()) {
    if (!["completed", "failed"].includes(lifecycle.execution_state)) continue;
    const session = byId.get(lifecycle.session_id);
    if (session && (session.status === "running" || session.has_open_owner)) {
      mismatches.push({
        sessionId: lifecycle.session_id,
        runnerState: lifecycle.execution_state,
        centralStatus: session.status,
        hasOpenOwner: session.has_open_owner,
      });
    }
  }
  return mismatches;
}

/** Whether a sample still has an open question of any kind. */
function unsettled(sample) {
  return sample.newViolations.length > 0 || (sample.pendingSessions ?? []).length > 0;
}

async function appendJsonLine(path, value) {
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function fileSize(path) {
  try { return (await stat(path)).size; } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function readFromOffset(path, offset) {
  try {
    const bytes = await readFile(path);
    return bytes.subarray(Math.min(offset, bytes.length)).toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function safeFileName(value) {
  return String(value).replaceAll(/[^A-Za-z0-9._-]/g, "-");
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
