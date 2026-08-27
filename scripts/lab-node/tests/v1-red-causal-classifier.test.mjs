import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const artifactDirectory = process.env.F9_ARTIFACT_DIR;
if (!artifactDirectory) {
  throw new Error("F9_ARTIFACT_DIR is required");
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ownerColumns = [
  "execution_manifest_id",
  "execution_runtime_env_identity",
  "execution_registration_id",
  "execution_pid",
  "execution_start_identity",
  "execution_command_id",
  "execution_lease_expires_at",
];

function canonicalOwnerIsOpen(row) {
  const values = ownerColumns.map((column) => row[column]);
  const allEmpty = values.every((value) => value === null);
  const allPopulated = values.every((value) => value !== null);
  assert.ok(allEmpty || allPopulated, "canonical owner must be all-empty or all-populated");
  return allPopulated;
}

function terminalProjectionMismatch({ runnerState, centralStatus, hasOpenOwner }) {
  return ["completed", "failed"].includes(runnerState)
    && (centralStatus === "running" || hasOpenOwner);
}

function readRepositoryFile(relativePath) {
  return readFileSync(`${repositoryRoot}/${relativePath}`, "utf8");
}

test("F9 legacy owner observation disappears under the V1 canonical owner predicate", () => {
  const result = JSON.parse(readFileSync(`${artifactDirectory}/result.json`, "utf8"));
  const scenario = result.scenarioResults.find(({ id }) => id === "F9");
  assert.ok(scenario);
  assert.equal(scenario.sessionStatus, "completed");
  assert.equal(scenario.inFlightOwnerships.length, 1);
  assert.equal(scenario.inFlightOwnerships[0].phase, "active");
  assert.equal(scenario.invariant.snapshot.terminalProjectionMismatches.length, 1);

  const evidenceSource = readRepositoryFile("scripts/lab-node/fault-harness-evidence.mjs");
  const scenarioSource = readRepositoryFile("scripts/lab-node/fault-scenarios.mjs");
  const schema = readRepositoryFile("packages/db-schema/sql/schema.sql");
  assert.match(evidenceSource, /FROM session_execution_ownerships AS ownership/);
  assert.match(scenarioSource, /runtime\.ownerships\(sessionId\)/);
  for (const column of ownerColumns) {
    assert.match(schema, new RegExp(`${column} = NULL`));
  }

  const observation = scenario.invariant.snapshot.terminalProjectionMismatches[0];
  const legacyViolation = terminalProjectionMismatch(observation);
  const releasedCanonicalRow = Object.fromEntries(ownerColumns.map((column) => [column, null]));
  const canonicalViolation = terminalProjectionMismatch({
    ...observation,
    hasOpenOwner: canonicalOwnerIsOpen(releasedCanonicalRow),
  });

  assert.equal(legacyViolation, true);
  assert.equal(canonicalViolation, false);
  console.log(`F9_COUNTERFACTUAL ${JSON.stringify({
    runId: result.runId,
    sessionId: scenario.sessionId,
    legacyViolation,
    canonicalViolation,
    legacyPhase: scenario.inFlightOwnerships[0].phase,
  })}`);
});

test("the canonical terminal-owner oracle catches a populated owner and accepts release", () => {
  const openCanonicalRow = {
    execution_manifest_id: "manifest-mutation",
    execution_runtime_env_identity: "runtime-mutation",
    execution_registration_id: "registration-mutation",
    execution_pid: 4242,
    execution_start_identity: "start-mutation",
    execution_command_id: "execute-mutation",
    execution_lease_expires_at: "2099-01-01T00:00:00.000Z",
  };
  const releasedCanonicalRow = Object.fromEntries(ownerColumns.map((column) => [column, null]));
  const mutationDetected = terminalProjectionMismatch({
    runnerState: "completed",
    centralStatus: "completed",
    hasOpenOwner: canonicalOwnerIsOpen(openCanonicalRow),
  });
  const releasedAccepted = !terminalProjectionMismatch({
    runnerState: "completed",
    centralStatus: "completed",
    hasOpenOwner: canonicalOwnerIsOpen(releasedCanonicalRow),
  });

  assert.equal(mutationDetected, true);
  assert.equal(releasedAccepted, true);
  console.log(`F9_ORACLE_MUTATION ${JSON.stringify({ mutationDetected, releasedAccepted })}`);
});

test("activate rollback has a V1 semantic seam after identity and rejected canonical acquire", () => {
  const scenarioSource = readRepositoryFile("scripts/lab-node/fault-scenarios.mjs");
  const executorSource = readRepositoryFile("soul-server-ts/src/task/task_executor.ts");
  assert.match(scenarioSource, /phase === "identity_proven"/);
  assert.doesNotMatch(executorSource, /identity_proven/);

  const identityAt = executorSource.indexOf("prepareExecutionIdentity?.()");
  const acquireAt = executorSource.indexOf("executionOwnershipCoordinator.acquire(", identityAt);
  const conflictAt = executorSource.indexOf("throw this.executionOwnershipConflict", acquireAt);
  const rollbackAt = executorSource.indexOf("rollbackExecutionIdentity(proof)", acquireAt);
  const inputAt = executorSource.indexOf("_consumeEventStream(task, runner, agent)", acquireAt);
  assert.ok(identityAt >= 0 && acquireAt > identityAt);
  assert.ok(conflictAt > acquireAt && inputAt > conflictAt);
  assert.ok(rollbackAt > inputAt);

  console.log(`ACTIVATE_ROLLBACK_SEAM ${JSON.stringify({
    oldSignal: "legacy identity_proven",
    newSignal: "complete identity -> canonical acquire rejected",
    rejectedBeforeInput: true,
    rollbackInCatch: true,
  })}`);
});
