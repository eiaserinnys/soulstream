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
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  LabDatabase,
  groupEventsBySession,
} from "./fault-harness-database.mjs";
import { findUnansweredDemands } from "./fault-harness-verdict.mjs";

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

export async function rejudgeDirectory(directory, database) {
  const window = await readWindow(directory);
  const reported = await readReportedStatus(directory);
  if (!window) {
    return { directory: basename(directory), verdict: "unreadable", reported };
  }
  const inputs = await database.pairingInputs(window.since, window.until);
  const sessions = inputs?.sessions ?? [];
  if (sessions.length === 0) {
    // The lab database is rebuilt from time to time. Evidence older than the
    // current database cannot be re-judged, and saying so is the point: the
    // stored evidence was never self-contained enough to carry its own inputs.
    return {
      directory: basename(directory),
      verdict: "evidence_expired",
      reported,
      window,
    };
  }
  const losses = findUnansweredDemands(
    sessions,
    groupEventsBySession(inputs?.events),
    Date.now(),
  );
  return {
    directory: basename(directory),
    verdict: losses.length > 0 ? "red" : "green",
    reported,
    window,
    sessionCount: sessions.length,
    unansweredCount: losses.length,
    unanswered: losses,
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
    results.push(await rejudgeDirectory(directory, database));
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
      + ` unanswered=${entry.unansweredCount ?? "-"}  ${entry.directory}\n`,
    );
    for (const loss of entry.unanswered ?? []) {
      process.stdout.write(
        `    ${loss.session_id} status=${loss.status}`
        + ` #${loss.demand_event_id} ${loss.demand_event_type}: ${loss.excerpt}\n`,
      );
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
