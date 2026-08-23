#!/usr/bin/env node
import { parseHarnessArguments } from "./fault-harness-contract.mjs";
import {
  reportMutationGate,
  runMutationGate,
} from "./fault-harness-mutation.mjs";
import { LabRuntime } from "./fault-harness-runtime.mjs";
import {
  canonicalScenarioOrder,
  runCanonicalScenario,
} from "./fault-scenarios.mjs";
import { runTrafficCycles } from "./fault-traffic-cycles.mjs";

const options = parseHarnessArguments(process.argv.slice(2));
const runtime = new LabRuntime();

if (options.command === "mutation") {
  // Runs before the stack has to be healthy: it only needs the database and
  // the release manifest, and a lab too broken to serve a session is exactly
  // when you want to know whether the judges still work.
  const mutationResults = await runMutationGate(runtime);
  process.exitCode = reportMutationGate(mutationResults) ? 0 : 1;
  process.exit(process.exitCode);
}

await runtime.assertReady();
const recorder = await runtime.createRun(runLabel(options));
await recorder.event("harness_started", { options });

const scenarioResults = [];
let cycleResults = [];
let fatalFailure;
try {
  if (options.command === "scenario") {
    scenarioResults.push(await runCanonicalScenario(options.scenarioId, runtime, recorder));
  } else if (options.command === "all") {
    for (const scenarioId of canonicalScenarioOrder()) {
      await ensureLabReady(runtime);
      scenarioResults.push(await runCanonicalScenario(scenarioId, runtime, recorder));
    }
    cycleResults = await runTrafficCycles(
      { concurrency: 1, cycles: 1, intervalSeconds: 0 },
      runtime,
      recorder,
    );
  } else {
    cycleResults = await runTrafficCycles(options, runtime, recorder);
  }
} catch (error) {
  fatalFailure = serializeError(error);
  await recorder.event("harness_fatal", fatalFailure);
}

const allResults = [...scenarioResults, ...cycleResults];
// A scenario that could not establish its injection window proves nothing. It
// is not a failure, but it must never read as coverage either.
const skipped = allResults.filter((result) => result.status === "skipped_precondition");
// Started from a red lab, so the verdict subtracted a violation that was
// already there. Reported apart from both passes and failures: it is neither.
const INCONCLUSIVE_STATUSES = new Set([
  "inconclusive_dirty_baseline",
  "inconclusive_unresolved_pending",
]);
const inconclusive = allResults.filter((result) => INCONCLUSIVE_STATUSES.has(result.status));
const failures = allResults.filter((result) => (
  (result.status !== "passed"
    && result.status !== "skipped_precondition"
    && !INCONCLUSIVE_STATUSES.has(result.status))
  || result.invariant?.newViolations?.length > 0
));
const summary = await recorder.finish({
  command: options.command,
  status: fatalFailure || failures.length > 0
    ? "failed"
    : (inconclusive.length > 0 ? "inconclusive" : "passed"),
  fatalFailure,
  scenarioResults,
  cycleResults,
  skipped: skipped.map((result) => ({ id: result.id, reason: result.reason })),
  inconclusive: inconclusive.map((result) => ({
    id: result.id,
    reason: result.reason,
    baselineViolations: result.baselineViolations,
    unresolvedPending: result.unresolvedPending,
  })),
  failureCount: failures.length + (fatalFailure ? 1 : 0),
  inconclusiveCount: inconclusive.length,
});

process.stdout.write(`${JSON.stringify({
  status: summary.status,
  runId: summary.runId,
  evidenceDirectory: recorder.directory,
  failureCount: summary.failureCount,
  skipped: summary.skipped,
  inconclusive: summary.inconclusive,
}, null, 2)}\n`);
if (summary.status !== "passed") process.exitCode = 1;

async function ensureLabReady(target) {
  try { await target.assertReady(); } catch { await target.startStack(); }
}

function runLabel(value) {
  return value.command === "scenario" ? `scenario-${value.scenarioId}` : value.command;
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}
