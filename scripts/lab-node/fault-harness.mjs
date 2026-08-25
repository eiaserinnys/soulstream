#!/usr/bin/env node
import { parseHarnessArguments } from "./fault-harness-contract.mjs";
import { bindHarnessBoundary } from "./fault-harness-boundary.mjs";
import {
  reportMutationGate,
  runMutationGate,
} from "./fault-harness-mutation.mjs";
import { LabRuntime } from "./fault-harness-runtime.mjs";
import {
  classifyHarnessStatus,
  preflightRefusalReasons,
} from "./fault-scenario-result.mjs";
import {
  canonicalScenarioOrder,
  runCanonicalScenario,
} from "./fault-scenarios.mjs";
import { runTrafficCycles } from "./fault-traffic-cycles.mjs";

const invokeTrafficCycles = bindHarnessBoundary(runTrafficCycles);

const options = parseHarnessArguments(process.argv.slice(2));
const runtime = new LabRuntime();
const provenance = await runtime.assertProvenance();
const recorder = await runtime.createRun(runLabel(options), provenance);
await recorder.event("harness_started", { options, provenance });
const invariantPreflight = await recorder.invariant("preflight");
const residue = await runtime.fixtureResidue();
const preflight = {
  violations: invariantPreflight.violations,
  ...residue,
};
const preflightReasons = preflightRefusalReasons(preflight);
await recorder.event("preflight_checked", { preflight, preflightReasons });

if (preflightReasons.length > 0) {
  const summary = await recorder.finish({
    command: options.command,
    status: "refused_dirty_baseline",
    preflight,
    preflightReasons,
    failureCount: 0,
    inconclusiveCount: 0,
  });
  process.stdout.write(`${JSON.stringify({
    status: summary.status,
    runId: summary.runId,
    evidenceDirectory: recorder.directory,
    preflightReasons,
  }, null, 2)}\n`);
  process.exit(1);
}

if (options.command === "mutation") {
  // Runs before the stack has to be healthy: it only needs the database and
  // the release manifest, and a lab too broken to serve a session is exactly
  // when you want to know whether the judges still work.
  const mutationResults = await runMutationGate(runtime);
  const passed = reportMutationGate(mutationResults);
  await recorder.finish({
    command: options.command,
    status: passed ? "passed" : "failed",
    mutationResults,
    failureCount: passed ? 0 : 1,
    inconclusiveCount: 0,
  });
  process.exit(passed ? 0 : 1);
}

await runtime.assertReady();
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
    cycleResults = await invokeTrafficCycles(
      { concurrency: 1, cycles: 1, intervalSeconds: 0 },
      runtime,
      recorder,
    );
  } else {
    cycleResults = await invokeTrafficCycles(options, runtime, recorder);
  }
} catch (error) {
  fatalFailure = serializeError(error);
  await recorder.event("harness_fatal", fatalFailure);
}

const allResults = [...scenarioResults, ...cycleResults];
// A scenario that could not establish its injection window proves nothing. It
// is not a failure, but it must never read as coverage either.
const skipped = allResults.filter((result) => result.status === "skipped_precondition");
const INCONCLUSIVE_STATUSES = new Set([
  "inconclusive_dirty_baseline",
  "inconclusive_timing_window",
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
  status: classifyHarnessStatus({
    fatalFailure,
    failureCount: failures.length,
    inconclusiveCount: inconclusive.length,
  }),
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
