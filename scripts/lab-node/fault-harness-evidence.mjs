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
  async invariant(label, messageLosses = [], baseline = [], settleMs = 0) {
    const deadline = Date.now() + settleMs;
    let sample = await this.sampleOnce(label, messageLosses, baseline);
    while (sample.newViolations.length > 0 && Date.now() < deadline) {
      await delay(5_000);
      sample = await this.sampleOnce(label, messageLosses, baseline);
    }
    sample.settled = sample.newViolations.length === 0;
    await appendJsonLine(this.invariantsPath, sample);
    return sample;
  }

  async sampleOnce(label, messageLosses, baseline) {
    await delay(2_000);
    const sample = { label, since: this.since,
      ...(await sampleInvariants(this.runtime, messageLosses, this.since)) };
    sample.newViolations = newInvariantViolations(baseline, sample.violations);
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

async function sampleInvariants(runtime, messageLosses, since) {
  const database = await runtime.psqlOne(`
    SELECT json_build_object(
      'ownerlessRunning', (
        SELECT COUNT(*)::integer FROM sessions AS session
        WHERE session.status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM session_execution_ownerships AS ownership
            WHERE ownership.session_id = session.session_id
              AND ownership.phase IN ('reserved', 'identity_proven', 'active')
          )
      ),
      'overdueRetries', (
        SELECT COUNT(*)::integer FROM session_deliveries
        WHERE aggregate_state = 'pending'
          AND state = 'pending'
          AND next_attempt_at < NOW() - INTERVAL '5 seconds'
      ),
      'ambiguousUncertain', (
        SELECT COUNT(*)::integer FROM session_deliveries
        WHERE state = 'uncertain' AND aggregate_state <> 'dead_letter'
      ),
      'reasonlessDeadLetters', (
        SELECT COUNT(*)::integer FROM session_deliveries
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
      'unansweredUserInput', (
        -- A user turn that never produced an assistant reply. Delivery
        -- bookkeeping can look perfectly clean while this is true: the 260822
        -- F9 reproduction lost a reply with zero dead letters, zero overdue
        -- retries and zero uncertain deliveries. Only the reply itself proves
        -- the message arrived somewhere that could answer it.
        --
        -- Sessions that are still working are exempt until they go quiet, so
        -- an in-flight turn is never reported as a loss.
        SELECT COALESCE(json_agg(row_to_json(unanswered)), '[]'::json) FROM (
          SELECT session.session_id, session.status,
            asked.last_user_id, answered.last_assistant_id, asked.last_event_at
          FROM sessions AS session
          JOIN LATERAL (
            SELECT MAX(id) FILTER (WHERE event_type = 'user_message') AS last_user_id,
              MAX(created_at) AS last_event_at
            FROM events WHERE events.session_id = session.session_id
          ) AS asked ON TRUE
          LEFT JOIN LATERAL (
            SELECT MAX(id) AS last_assistant_id FROM events
            WHERE events.session_id = session.session_id
              AND events.event_type = 'assistant_message'
          ) AS answered ON TRUE
          WHERE asked.last_user_id IS NOT NULL
            AND (
              answered.last_assistant_id IS NULL
              OR answered.last_assistant_id < asked.last_user_id
            )
            AND session.created_at >= ${sqlTimestamp(since)}
            AND (
              session.status NOT IN ('running', 'initializing')
              -- Quiet, not merely unfinished. Session status alone is the
              -- wrong exemption: the 260822 F9 reproduction sat in the running
              -- status with nothing happening, so a status-based grace let the
              -- very failure the run was chasing pass as healthy.
              OR asked.last_event_at < NOW() - INTERVAL '3 minutes'
            )
        ) AS unanswered
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
  const terminalProjectionMismatches = await findTerminalProjectionMismatches(
    runtime.runnerStateDirectory,
    database?.sessions ?? [],
  );
  const manifest = await runtime.currentManifest();
  const receipt = database?.activationReceipt;
  const snapshot = {
    ownerlessRunning: database?.ownerlessRunning ?? 0,
    unansweredUserInput: database?.unansweredUserInput ?? [],
    terminalProjectionMismatches,
    overdueRetries: database?.overdueRetries ?? 0,
    ambiguousUncertain: database?.ambiguousUncertain ?? 0,
    reasonlessDeadLetters: database?.reasonlessDeadLetters ?? 0,
    activationManifestMismatch: !receipt
      || receipt.manifest_id !== manifest.manifestId
      || receipt.release_cohort_id !== manifest.releaseCohortId
      || receipt.source_commit !== manifest.sourceCommit,
    messageLosses,
  };
  return {
    sampledAt: new Date().toISOString(),
    snapshot,
    violations: evaluateInvariantSnapshot(snapshot),
  };
}

/** Quotes an ISO timestamp for inline SQL; rejects anything that is not one. */
function sqlTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`invalid invariant window timestamp: ${value}`);
  }
  return `TIMESTAMPTZ '${value}'`;
}

async function findTerminalProjectionMismatches(runnerStateDirectory, sessionRows) {
  const byId = new Map(sessionRows.map((row) => [row.session_id, row]));
  const mismatches = [];
  let entries = [];
  try { entries = await readdir(runnerStateDirectory, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    try {
      const lifecycle = JSON.parse(await readFile(
        join(runnerStateDirectory, entry.name, "runner-lifecycle.json"),
        "utf8",
      ));
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
    } catch {}
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
