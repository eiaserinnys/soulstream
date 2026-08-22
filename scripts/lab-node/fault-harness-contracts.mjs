/**
 * Boundary contracts: the wiring between modules, not the judges themselves.
 *
 * The mutation gate proves each judge can see a violating row. It cannot see
 * anything else, because it only ever plants rows -- so when this audit later
 * wired `pending` into the sampler, `capturedAt` into the replay, and a
 * marker check into the CI gate, all three sat outside the gate that was built
 * to stop exactly this. The review cut all three and the whole suite stayed
 * green: 44/44 tests, 8/8 mutations, exit 0.
 *
 * A fixed list of eight row-plantings cannot grow when the harness grows. So
 * boundaries get their own contracts, and each one drives the *real* code
 * across the *real* seam and asserts a consequence that only exists when the
 * wiring is there. Delete the wiring and the contract fails; there is nothing
 * to remember to update.
 *
 * These need no database. `fault-harness-ci-gate.mjs` runs them beside the
 * mutation gate, and `fault-harness-contracts.test.mjs` runs them in CI where
 * no lab exists at all.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvidenceRecorder, sampleInvariants } from "./fault-harness-evidence.mjs";
import { rejudgeDirectory } from "./fault-harness-rejudge.mjs";

const CAPTURED_AT = "2026-08-22T12:00:00.000Z";
const SINCE = "2026-08-22T11:00:00.000Z";

/**
 * A runtime whose database answers from a script, so the real sampler runs.
 *
 * Both statements the sampler issues are recognised by shape; anything else
 * throws rather than returning a plausible empty result, because an empty
 * result is what every one of these bugs looked like.
 */
function scriptedRuntime(sessions, events, directory) {
  return {
    runnerStateDirectory: directory,
    async currentManifest() {
      return { manifestId: "m", releaseCohortId: "c", sourceCommit: "s" };
    },
    async psqlOne(query) {
      if (query.includes("'ownerlessRunning'")) {
        return {
          ownerlessRunning: [], overdueRetries: [], ambiguousUncertain: [],
          reasonlessDeadLetters: [], sessions: [],
          activationReceipt: { manifest_id: "m", release_cohort_id: "c", source_commit: "s" },
        };
      }
      if (query.includes("'sessions'") && query.includes("'events'")) {
        return { sessions, events };
      }
      throw new Error(`unexpected statement in contract runtime: ${query.slice(0, 60)}`);
    },
  };
}

/** A session that is unmistakably mid-answer: fresh input, live runner. */
function pendingSession(now) {
  return {
    session_id: "contract-pending-session",
    status: "running",
    created_at: new Date(now - 5_000).toISOString(),
    last_event_at: new Date(now - 1_000).toISOString(),
  };
}

function pendingEvents(now) {
  return [{
    session_id: "contract-pending-session",
    id: 1,
    event_type: "user_message",
    text: "contract: answer me",
    created_at: new Date(now - 5_000).toISOString(),
  }];
}

export const BOUNDARY_CONTRACTS = Object.freeze([
  {
    name: "pending_reaches_the_snapshot",
    what: "a mid-answer session is reported as pending by the real sampler",
    async check() {
      const directory = await mkdtemp(join(tmpdir(), "harness-contract-"));
      try {
        const now = Date.now();
        const runtime = scriptedRuntime(
          [pendingSession(now)], pendingEvents(now), directory,
        );
        const sample = await sampleInvariants(runtime, SINCE);
        assert(
          (sample.pendingSessions ?? []).includes("contract-pending-session"),
          "the sampler did not report a mid-answer session as pending;"
          + " findPendingSessions is not wired into sampleInvariants",
        );
        assert(
          sample.violations.length === 0,
          "a session that may still answer was reported as a violation",
        );
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: "pending_blocks_the_settle_loop",
    what: "an unresolved pending session stops a sample from reading as settled",
    async check() {
      const directory = await mkdtemp(join(tmpdir(), "harness-contract-"));
      try {
        const now = Date.now();
        const runtime = scriptedRuntime(
          [pendingSession(now)], pendingEvents(now), directory,
        );
        const recorder = new EvidenceRecorder(runtime, "contract", directory);
        const sample = await recorder.invariant("contract", [], 0);
        assert(
          sample.settled === false,
          "a sample with an unresolved pending session reported settled;"
          + " the settle loop is ignoring pendingSessions",
        );
        assert(
          (sample.unresolvedPending ?? []).length > 0,
          "unresolvedPending was empty while a session was still mid-answer",
        );
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: "replay_uses_the_capture_clock",
    what: "stored evidence is judged at capturedAt, with no database",
    async check() {
      const directory = await mkdtemp(join(tmpdir(), "harness-contract-"));
      try {
        const capturedAtMs = Date.parse(CAPTURED_AT);
        // Mid-answer *at capture time*, and hours stale by the time this runs.
        await writeFile(join(directory, "invariants.jsonl"),
          `${JSON.stringify({ label: "before", since: SINCE })}\n`, { mode: 0o600 });
        await writeFile(join(directory, "result.json"),
          `${JSON.stringify({ completedAt: CAPTURED_AT, status: "passed" })}\n`, { mode: 0o600 });
        await writeFile(join(directory, "pairing-inputs.jsonl"),
          `${JSON.stringify({
            label: "after", since: SINCE, capturedAt: CAPTURED_AT,
            sessions: [pendingSession(capturedAtMs)],
            events: pendingEvents(capturedAtMs),
          })}\n`, { mode: 0o600 });
        // No database at all: the second argument is null on purpose.
        const result = await rejudgeDirectory(directory, null);
        assert(
          result.source === "stored_evidence",
          `replay did not read the stored capture (source=${result.source});`
          + " it cannot re-judge evidence without a live database",
        );
        assert(
          result.asOf === CAPTURED_AT,
          `replay judged at ${result.asOf} instead of the capture time ${CAPTURED_AT};`
          + " a session captured mid-answer turns red purely because time passed",
        );
        assert(
          result.verdict === "green",
          "a session that was mid-answer when captured was re-judged as a loss",
        );
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  },
]);

export async function runBoundaryContracts() {
  const results = [];
  for (const contract of BOUNDARY_CONTRACTS) {
    try {
      await contract.check();
      results.push({ name: contract.name, what: contract.what, outcome: "held" });
    } catch (error) {
      results.push({
        name: contract.name,
        what: contract.what,
        outcome: "BROKEN",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function reportBoundaryContracts(results) {
  for (const result of results) {
    process.stdout.write(
      `${result.outcome.padEnd(14)} ${result.name.padEnd(32)} ${result.what}\n`
      + (result.detail ? `               ${result.detail}\n` : ""),
    );
  }
  const broken = results.filter((result) => result.outcome !== "held");
  process.stdout.write(
    `\n${results.length} boundary contract(s): `
    + `${results.length - broken.length} held, ${broken.length} broken.\n`,
  );
  return broken.length === 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
