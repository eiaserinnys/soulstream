#!/usr/bin/env node
/**
 * Re-judges stored evidence directories with the current verdict.
 *
 * A judge that can only be exercised by producing a fresh fault is a judge
 * nobody will exercise. This replays what the lab already recorded, so a
 * change to the verdict can be checked against every run ever taken in
 * seconds, and a run that was reported clean can be asked again whether it
 * really was.
 *
 * Usage:
 *   fault-harness-rejudge.mjs                      # every evidence directory
 *   fault-harness-rejudge.mjs <directory> [...]    # named directories
 *   fault-harness-rejudge.mjs --json               # machine-readable
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  LabDatabase,
  groupEventsBySession,
} from "./fault-harness-database.mjs";
import { findUnansweredDemands } from "./fault-harness-verdict.mjs";
import {
  defineHarnessBoundary,
  invokeHarnessBoundary,
} from "./fault-harness-boundary.mjs";

const EVIDENCE_ROOT = join(
  process.env.LAB_ROOT ?? "/home/eias/services/soulstream-lab",
  "state",
  "fault-harness",
);

/**
 * The run's own bracket, with nothing added.
 *
 * An earlier draft padded the end by two minutes and pulled a neighbouring
 * run's session into the report. Attributing one run's loss to another is the
 * same class of error as the judge being audited: a verdict that names the
 * wrong subject cannot be acted on.
 */
const WINDOW_TAIL_MS = 0;

async function rejudgeDirectoryImpl(directory, database) {
  const window = await readWindow(directory);
  const reported = await readReportedStatus(directory);
  if (!window) {
    return { directory: basename(directory), verdict: "unreadable", reported };
  }
  // Stored inputs first.
  //
  // The run recorded exactly what its verdict was computed from, so replaying
  // those is a re-judgement of *that run* rather than of whatever the database
  // looks like now. It also works with no database at all, which is the whole
  // point of writing them: the first version of this file wrote the inputs and
  // then never read them, so pulling the database out still produced
  // `evidence_expired` on a directory that had the answer sitting in it.
  const stored = await readStoredInputs(directory);
  const inputs = stored ?? await readDatabaseInputs(database, window);
  const source = stored ? "stored_evidence" : "database";
  const sessions = inputs?.sessions ?? [];
  if (sessions.length === 0) {
    // Evidence written before the inputs were stored, whose sessions the
    // database no longer holds. Saying so is the point: that evidence was
    // never self-contained and cannot be re-checked by anyone, ever.
    return {
      directory: basename(directory),
      verdict: "evidence_expired",
      reported,
      window,
      source: stored ? "stored_evidence" : "database",
    };
  }
  // The clock the capture had, not the clock now.
  //
  // Reading stored inputs but judging them against `Date.now()` is not a
  // replay: a session that was legitimately mid-answer when captured turns
  // red thirty seconds later purely because time passed. `runnerProgressing`
  // travels with the inputs for the same reason -- it is read from disk at
  // sample time and cannot be recovered afterwards.
  const asOf = stored ? Date.parse(stored.capturedAt ?? "") || Date.now() : Date.now();
  const losses = findUnansweredDemands(sessions, groupEventsBySession(inputs?.events), asOf);
  return {
    directory: basename(directory),
    verdict: losses.length > 0 ? "red" : "green",
    reported,
    window,
    source,
    asOf: new Date(asOf).toISOString(),
    sessionCount: sessions.length,
    unansweredCount: losses.reduce((total, loss) => total + loss.unanswered_count, 0),
    unanswered: losses,
  };
}

export const rejudgeDirectory = defineHarnessBoundary({
  name: "replay_uses_the_capture_clock",
  what: "stored evidence is judged at capturedAt without consulting a live database",
  implementation: rejudgeDirectoryImpl,
  async contract(rejudge) {
    const directory = await mkdtemp(join(tmpdir(), "harness-contract-"));
    try {
      const capturedAt = "2026-08-22T12:00:00.000Z";
      const capturedAtMs = Date.parse(capturedAt);
      const since = "2026-08-22T11:00:00.000Z";
      await writeFile(
        join(directory, "invariants.jsonl"),
        `${JSON.stringify({ label: "before", since })}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        join(directory, "result.json"),
        `${JSON.stringify({ completedAt: capturedAt, status: "passed" })}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        join(directory, "pairing-inputs.jsonl"),
        `${JSON.stringify({
          label: "after",
          since,
          capturedAt,
          sessions: [pendingReplaySession(capturedAtMs)],
          events: [pendingReplayEvent(capturedAtMs)],
        })}\n`,
        { mode: 0o600 },
      );
      const result = await rejudge(directory, null);
      boundaryAssert(result.source === "stored_evidence", "replay did not use stored evidence");
      boundaryAssert(
        result.asOf === capturedAt,
        `replay judged at ${result.asOf} instead of ${capturedAt}`,
      );
      boundaryAssert(result.verdict === "green", "capture-time pending input replayed as loss");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

/** The database, when there is one and it still holds the run's sessions. */
async function readDatabaseInputs(database, window) {
  if (!database) return null;
  try { return await database.pairingInputs(window.since, window.until); } catch { return null; }
}

/**
 * The last recorded sample's inputs, from either evidence format.
 *
 * `.jsonl` is the current one, appended per sample; `.json` is what runs
 * between this audit's first and second pass wrote, kept readable so that
 * evidence is not orphaned by its own fix.
 */
async function readStoredInputs(directory) {
  try {
    const lines = (await readFile(join(directory, "pairing-inputs.jsonl"), "utf8"))
      .split("\n").filter(Boolean);
    if (lines.length > 0) return mergeCaptures(lines.map((line) => JSON.parse(line)));
  } catch {}
  try {
    return JSON.parse(await readFile(join(directory, "pairing-inputs.json"), "utf8"));
  } catch {}
  return null;
}

/**
 * Rebuilds a run's inputs from its appended deltas.
 *
 * Each line carries only what changed since the one before it, so the last
 * line alone is not the capture -- reading it that way would re-judge a run
 * against whatever happened to move in its final seconds. Sessions take their
 * latest recorded state, events accumulate, and `capturedAt` is the last
 * sample's, because that is the moment the run's verdict was fixed.
 */
function mergeCaptures(captures) {
  const sessions = new Map();
  const events = new Map();
  for (const capture of captures) {
    for (const session of capture.sessions ?? []) sessions.set(session.session_id, session);
    for (const event of capture.events ?? []) events.set(`${event.session_id}#${event.id}`, event);
  }
  const last = captures.at(-1);
  return {
    since: captures[0]?.since ?? last?.since,
    capturedAt: last?.capturedAt,
    sessions: [...sessions.values()],
    events: [...events.values()],
  };
}

/**
 * The window a run occupied.
 *
 * `since` is the recorder's own invariant window, which is what the live judge
 * used, so the replay sees the same sessions the run did.
 */
async function readWindow(directory) {
  const since = await firstInvariantSince(directory)
    ?? await firstEventTimestamp(directory);
  if (!since) return null;
  const completedAt = await readJson(join(directory, "result.json"))
    .then((value) => value?.completedAt ?? null)
    .catch(() => null);
  const until = new Date(
    Date.parse(completedAt ?? since) + WINDOW_TAIL_MS,
  ).toISOString();
  return { since, until };
}

async function firstInvariantSince(directory) {
  try {
    const lines = (await readFile(join(directory, "invariants.jsonl"), "utf8"))
      .split("\n").filter(Boolean);
    for (const line of lines) {
      const value = JSON.parse(line);
      if (typeof value.since === "string") return value.since;
    }
  } catch {}
  return null;
}

async function firstEventTimestamp(directory) {
  try {
    const [first] = (await readFile(join(directory, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean);
    return first ? JSON.parse(first).at : null;
  } catch {}
  return null;
}

async function readReportedStatus(directory) {
  const result = await readJson(join(directory, "result.json")).catch(() => null);
  if (!result) return { status: "no_result", invariantViolations: null };
  const invariantViolations = [
    ...(result.scenarioResults ?? []),
    ...(result.cycleResults ?? []),
  ].flatMap((entry) => entry.invariant?.newViolations ?? []).length;
  return { status: result.status ?? "unknown", invariantViolations };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const named = args.filter((value) => !value.startsWith("--"));
  const directories = named.length > 0
    ? named.map((value) => (value.includes("/") ? value : join(EVIDENCE_ROOT, value)))
    : (await readdir(EVIDENCE_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(EVIDENCE_ROOT, entry.name))
      .sort();
  const database = new LabDatabase();
  const results = [];
  for (const directory of directories) {
    results.push(await invokeHarnessBoundary(rejudgeDirectory, directory, database));
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  printReport(results);
}

function printReport(results) {
  const red = results.filter((entry) => entry.verdict === "red");
  const green = results.filter((entry) => entry.verdict === "green");
  const expired = results.filter((entry) => entry.verdict === "evidence_expired");
  for (const entry of results) {
    const reported = entry.reported?.status ?? "?";
    process.stdout.write(
      `${entry.verdict.padEnd(17)} reported=${String(reported).padEnd(7)}`
      + ` via=${(entry.source ?? "-").padEnd(15)}`
      + ` unanswered=${entry.unansweredCount ?? "-"}  ${entry.directory}\n`,
    );
    for (const loss of entry.unanswered ?? []) {
      const shape = loss.ambiguous
        ? `${loss.unanswered_count} of ${loss.candidates.length} unanswered (which one is not in the events)`
        : `${loss.unanswered_count} unanswered`;
      process.stdout.write(`    ${loss.session_id} status=${loss.status} ${shape}\n`);
      for (const candidate of loss.candidates) {
        process.stdout.write(
          `      #${candidate.event_id} ${candidate.event_type}: ${candidate.excerpt}\n`,
        );
      }
    }
  }
  const flippedToRed = red.filter((entry) => entry.reported?.status === "passed");
  process.stdout.write(
    `\n${results.length} run(s): ${red.length} red, ${green.length} green,`
    + ` ${expired.length} not re-judgeable.\n`
    + `${flippedToRed.length} run(s) reported passed are red under the pairing verdict.\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

function pendingReplaySession(now) {
  return {
    session_id: "contract-pending-session",
    status: "running",
    created_at: new Date(now - 5_000).toISOString(),
    last_event_at: new Date(now - 1_000).toISOString(),
    runnerProgressing: true,
  };
}

function pendingReplayEvent(now) {
  return {
    session_id: "contract-pending-session",
    id: 1,
    event_type: "user_message",
    text: "contract: answer me",
    created_at: new Date(now - 5_000).toISOString(),
  };
}

function boundaryAssert(condition, message) {
  if (!condition) throw new Error(message);
}
