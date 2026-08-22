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
import { findUnansweredDemands } from "./fault-harness-verdict.mjs";

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
    let sample = await this.sampleOnce(label, baseline);
    while (sample.newViolations.length > 0 && Date.now() < deadline) {
      await delay(5_000);
      sample = await this.sampleOnce(label, baseline);
    }
    sample.settled = sample.newViolations.length === 0;
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
    await writeFile(
      join(this.directory, "pairing-inputs.json"),
      `${JSON.stringify({ since: this.since, capturedAt: sample.sampledAt, ...pairingInputs }, null, 2)}\n`,
      { mode: 0o600 },
    );
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
  const unansweredDemands = findUnansweredDemands(
    pairedSessions,
    groupEventsBySession(pairingInputs?.events),
    Date.now(),
  );
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
    pairingInputs,
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
