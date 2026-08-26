#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalScenarioOrder } from "./fault-scenarios.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const INCONCLUSIVE_SCENARIO_STATUSES = new Set([
  "skipped_precondition",
  "inconclusive_dirty_baseline",
  "inconclusive_timing_window",
  "inconclusive_unresolved_pending",
]);

export const PRIORITY_FAULT_SCENARIOS = Object.freeze([
  "F1",
  "F11",
  "F9",
  "dead-owner",
  "F7",
]);

export function aggregateScenarioExecutions(scenarioIds, executions) {
  const expected = new Set();
  for (const id of scenarioIds) {
    if (expected.has(id)) throw new Error(`duplicate scenario inventory: ${id}`);
    expected.add(id);
  }

  const byId = new Map();
  for (const execution of executions) {
    if (!expected.has(execution.id)) {
      throw new Error(`unexpected scenario execution: ${execution.id}`);
    }
    if (byId.has(execution.id)) {
      throw new Error(`duplicate scenario execution: ${execution.id}`);
    }
    byId.set(execution.id, execution);
  }

  const scenarioResults = scenarioIds.map((id) => {
    const execution = byId.get(id);
    if (!execution) throw new Error(`missing scenario execution: ${id}`);
    return {
      ...execution,
      id,
      reached: true,
      verdict: scenarioExecutionVerdict(execution),
    };
  });
  const failureCount = scenarioResults.filter(
    ({ verdict }) => verdict === "failed" || verdict === "timeout",
  ).length;
  const inconclusiveCount = scenarioResults.filter(
    ({ verdict }) => verdict === "inconclusive",
  ).length;
  return {
    status: failureCount > 0
      ? "failed"
      : inconclusiveCount > 0 ? "inconclusive" : "passed",
    scenarioResults,
    failureCount,
    inconclusiveCount,
  };
}

export function scenarioExecutionVerdict(execution) {
  if (execution.exitCode === 124) return "timeout";
  if (INCONCLUSIVE_SCENARIO_STATUSES.has(execution.scenarioStatus)) {
    return "inconclusive";
  }
  if (
    execution.exitCode === 0
    && execution.scenarioStatus === "passed"
    && execution.harnessStatus === "passed"
  ) {
    return "passed";
  }
  return "failed";
}

export async function runScenarioInventory(scenarioIds, executeScenario) {
  const executions = [];
  for (const id of scenarioIds) {
    try {
      executions.push({ id, ...await executeScenario(id) });
    } catch (error) {
      executions.push({ id, exitCode: null, processError: serializeError(error) });
    }
  }
  return executions;
}

export async function runScenarioSuite(command, env = process.env) {
  if (env.SOULSTREAM_HEAVY_LOCK_HELD !== "1") {
    throw new Error("scenario suite requires the shared heavy lock");
  }
  const scenarioIds = command === "all"
    ? canonicalScenarioOrder()
    : command === "faults" ? [...PRIORITY_FAULT_SCENARIOS] : null;
  if (!scenarioIds) throw new Error("usage: fault-harness.sh <all|faults>");

  const labRoot = requiredEnvironment(env, "LAB_ROOT");
  const evidenceRoot = join(labRoot, "state", "fault-harness");
  const cleanRun = join(directory, "clean-run.sh");
  const startedAt = new Date().toISOString();
  const executions = await runScenarioInventory(scenarioIds, async (id) => {
    process.stdout.write(`scenario suite: starting ${id}\n`);
    const before = await scenarioEvidenceNames(evidenceRoot, id);
    const started = new Date().toISOString();
    const processResult = await runCleanScenario(cleanRun, id, env);
    const completed = new Date().toISOString();
    const after = await scenarioEvidenceNames(evidenceRoot, id);
    const created = [...after].filter((name) => !before.has(name)).sort();
    const evidenceDirectory = created.length === 1
      ? join(evidenceRoot, created[0])
      : null;
    const evidence = evidenceDirectory
      ? await readScenarioEvidence(evidenceDirectory, id)
      : {};
    const execution = {
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      startedAt: started,
      completedAt: completed,
      evidenceDirectory,
      evidenceDiscoveryError: created.length <= 1
        ? undefined
        : `multiple evidence directories created: ${created.join(", ")}`,
      processError: processResult.error,
      ...evidence,
    };
    process.stdout.write(
      `scenario suite: finished ${id} as ${scenarioExecutionVerdict(execution)}\n`,
    );
    return execution;
  });

  const aggregate = aggregateScenarioExecutions(scenarioIds, executions);
  const completedAt = new Date().toISOString();
  const result = {
    kind: "scenario_aggregate",
    command,
    startedAt,
    completedAt,
    ceilingSeconds: Number(requiredEnvironment(
      env,
      "LAB_HARNESS_PROCESS_CEILING_SECONDS",
    )),
    ...aggregate,
  };
  const resultPath = join(
    evidenceRoot,
    `aggregate-${command}-${startedAt.replaceAll(/[:.]/g, "-")}.json`,
  );
  const temporaryPath = `${resultPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, resultPath);
  return { ...result, resultPath };
}

async function runCleanScenario(cleanRun, id, env) {
  return await new Promise((resolveProcess) => {
    let spawnError;
    const child = spawn(cleanRun, ["scenario", id], {
      env: {
        ...env,
        LAB_SCENARIO_SUITE_CHILD: "1",
        SOULSTREAM_HEAVY_LOCK_HELD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => { spawnError = serializeError(error); });
    child.on("close", (exitCode, signal) => {
      resolveProcess({ exitCode, signal, error: spawnError });
    });
  });
}

async function scenarioEvidenceNames(root, id) {
  const prefix = `scenario-${id}-`;
  const entries = await readdir(root, { withFileTypes: true });
  return new Set(entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(prefix),
  ).map((entry) => entry.name));
}

async function readScenarioEvidence(evidenceDirectory, id) {
  try {
    const summary = JSON.parse(await readFile(join(evidenceDirectory, "result.json"), "utf8"));
    const scenario = summary.scenarioResults?.find((result) => result.id === id);
    return {
      harnessStatus: summary.status,
      scenarioStatus: scenario?.status,
      scenarioReason: scenario?.reason,
    };
  } catch {
    return {};
  }
}

function requiredEnvironment(env, key) {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function main() {
  try {
    const result = await runScenarioSuite(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`fault-harness-suite: ${serializeError(error).message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
