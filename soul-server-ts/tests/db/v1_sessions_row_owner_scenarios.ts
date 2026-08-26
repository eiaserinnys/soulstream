import type { EnginePort, EngineExecuteParams, SSEEventPayload } from
  "../../src/engine/protocol.js";
import { InProcessRunnerCommandDispatcher } from
  "../../src/runner/runner_command_dispatcher.js";
import type {
  AcquirePath,
  CompleteIdentity,
  OwnerSnapshot,
  V1OwnerBoundary,
  V1OwnerMutation,
} from "./v1_sessions_row_owner_contract.js";

export type V1ContractAxis = "competition" | "identity" | "release";

export interface V1AxisObservation {
  axis: V1ContractAxis;
  violations: string[];
  diagnostic: Record<string, unknown>;
}

export type V1ContractObservation = Record<V1ContractAxis, V1AxisObservation>;

export const V1_MUTATION_SENTINELS: Record<V1OwnerMutation, string> = {
  remove_for_update: "v5-vs-v5:admitted_candidates:2",
  remove_generation_predicate: "stale_renew:generation_fence_missing",
  remove_identity_check: "partial_identity_persisted",
  split_release_atomicity: "release_partial_state_visible",
};

const BASE_TIME = new Date("2026-08-27T00:00:00.000Z");
const BEFORE_EXPIRY = new Date("2026-08-27T00:00:05.000Z");
const AFTER_EXPIRY = new Date("2026-08-27T00:00:11.000Z");
const LEASE = new Date("2026-08-27T00:00:10.000Z");
const NEXT_LEASE = new Date("2026-08-27T00:00:30.000Z");

export async function observeV1Contract(
  boundary: V1OwnerBoundary,
  namespace: string,
): Promise<V1ContractObservation> {
  return {
    competition: await observeCompetition(boundary, namespace),
    identity: await observeIdentity(boundary, namespace),
    release: await observeRelease(boundary, namespace),
  };
}

async function observeCompetition(
  boundary: V1OwnerBoundary,
  namespace: string,
): Promise<V1AxisObservation> {
  const variants: ReadonlyArray<readonly [string, AcquirePath, AcquirePath]> = [
    ["v5-vs-v5", "v5", "v5"],
    ["v5-vs-legacy-reserve", "v5", "legacy_reserve"],
    ["v5-vs-legacy-adopt", "v5", "legacy_adopt"],
  ];
  const violations: string[] = [];
  const races: Record<string, unknown>[] = [];

  for (const [label, firstPath, secondPath] of variants) {
    const sessionId = `${namespace}-competition-${label}`;
    await boundary.resetSession(sessionId);
    const first = await createCandidate(`${label}-a`);
    const second = await createCandidate(`${label}-b`);
    const raceKey = `${namespace}:${label}`;
    const results = await Promise.all([
      boundary.acquire(acquireInput(sessionId, 1, first.identity, firstPath, raceKey)),
      boundary.acquire(acquireInput(sessionId, 2, second.identity, secondPath, raceKey)),
    ]);
    if (results[0]!.applied) await first.runInput("winner-candidate-a");
    if (results[1]!.applied) await second.runInput("winner-candidate-b");
    const admitted = results.filter((result) => result.applied).length;
    const inputCount = first.inputs.length + second.inputs.length;
    const snapshot = await boundary.snapshot(sessionId);
    if (admitted !== 1) violations.push(`${label}:admitted_candidates:${admitted}`);
    if (inputCount !== 1) violations.push(`${label}:engine_inputs:${inputCount}`);
    if (!snapshot.ownerStoredOnSessionsRow) {
      violations.push(`${label}:owner_not_on_sessions_row`);
    }
    if (snapshot.identity === null) violations.push(`${label}:owner_identity_missing`);
    races.push({
      label,
      applied: results.map((result) => result.applied),
      inputs: [first.inputs.length, second.inputs.length],
      ownerGeneration: snapshot.generation,
      ownerStoredOnSessionsRow: snapshot.ownerStoredOnSessionsRow,
    });
  }

  return {
    axis: "competition",
    violations,
    diagnostic: { boundary: boundary.label, races },
  };
}

async function observeIdentity(
  boundary: V1OwnerBoundary,
  namespace: string,
): Promise<V1AxisObservation> {
  const sessionId = `${namespace}-identity`;
  const partialSessionId = `${namespace}-partial-identity`;
  await boundary.resetSession(sessionId);
  const owner = await createCandidate("identity-owner");
  const initial = await boundary.acquire(
    acquireInput(sessionId, 41, owner.identity, "v5"),
  );
  const initialSnapshot = await boundary.snapshot(sessionId);
  const firstFrameCommandId = owner.identity.executionCommandId;
  await owner.runInput("turn-one");
  const secondFrameCommandId = await owner.prepareNextFrameCommand();
  await owner.runInput("turn-two");
  const afterTurns = await boundary.snapshot(sessionId);
  const reconnect = await boundary.acquire({
    ...acquireInput(sessionId, 99, owner.identity, "v5"),
    acquiredAt: BEFORE_EXPIRY,
    leaseExpiresAt: NEXT_LEASE,
  });
  const reconnectSnapshot = await boundary.snapshot(sessionId);

  const mismatchResults = await Promise.all([
    boundary.acquire({
      ...acquireInput(sessionId, 100, { ...owner.identity, pid: owner.identity.pid + 1 }, "v5"),
      acquiredAt: BEFORE_EXPIRY,
      leaseExpiresAt: NEXT_LEASE,
    }),
    boundary.acquire({
      ...acquireInput(
        sessionId,
        101,
        { ...owner.identity, startIdentity: `${owner.identity.startIdentity}:other` },
        "v5",
      ),
      acquiredAt: BEFORE_EXPIRY,
      leaseExpiresAt: NEXT_LEASE,
    }),
    boundary.acquire({
      ...acquireInput(
        sessionId,
        102,
        { ...owner.identity, executionCommandId: "owner-token:other" },
        "v5",
      ),
      acquiredAt: BEFORE_EXPIRY,
      leaseExpiresAt: NEXT_LEASE,
    }),
  ]);

  const successor = await createCandidate("identity-successor");
  const takeover = await boundary.acquire({
    ...acquireInput(sessionId, 103, successor.identity, "v5"),
    acquiredAt: new Date("2026-08-27T00:00:31.000Z"),
    leaseExpiresAt: new Date("2026-08-27T00:01:00.000Z"),
  });
  const lateOldReconnect = await boundary.acquire({
    ...acquireInput(sessionId, 104, owner.identity, "v5"),
    acquiredAt: new Date("2026-08-27T00:00:32.000Z"),
    leaseExpiresAt: new Date("2026-08-27T00:01:00.000Z"),
  });

  await boundary.resetSession(partialSessionId);
  const partial = await boundary.injectPartialIdentity(partialSessionId);
  const violations: string[] = [];
  if (!initial.applied) violations.push("initial_acquire_rejected");
  if (!initialSnapshot.ownerStoredOnSessionsRow) violations.push("owner_not_on_sessions_row");
  if (!sameIdentity(initialSnapshot.identity, owner.identity)) {
    violations.push("complete_identity_not_persisted");
  }
  if (firstFrameCommandId === secondFrameCommandId) {
    violations.push("frame_command_did_not_change");
  }
  if (afterTurns.identity?.executionCommandId !== firstFrameCommandId) {
    violations.push("owner_token_changed_with_frame_command");
  }
  if (!reconnect.applied) violations.push("exact_reconnect_rejected");
  if (reconnect.generation !== initial.generation) {
    violations.push("exact_reconnect_generation_changed");
  }
  if (reconnectSnapshot.generation !== initialSnapshot.generation) {
    violations.push("persisted_generation_changed_before_expiry");
  }
  for (const [index, result] of mismatchResults.entries()) {
    if (result.applied) violations.push(`identity_mismatch_${index + 1}_admitted`);
  }
  if (!takeover.applied) violations.push("expired_takeover_rejected");
  if (
    takeover.generation !== null
    && initial.generation !== null
    && takeover.generation !== initial.generation + 1
  ) {
    violations.push("expired_takeover_generation_not_incremented");
  }
  if (lateOldReconnect.applied) violations.push("late_old_identity_reconnected");
  if (!partial.supported) violations.push("all_or_none_check_unavailable");
  if (!partial.rejected) violations.push("partial_identity_not_rejected");
  if (partial.partialPersisted) violations.push("partial_identity_persisted");

  return {
    axis: "identity",
    violations,
    diagnostic: {
      boundary: boundary.label,
      initial,
      frameCommandIds: [firstFrameCommandId, secondFrameCommandId],
      ownerCommandAfterTurns: afterTurns.identity?.executionCommandId ?? null,
      reconnect,
      mismatchApplied: mismatchResults.map((result) => result.applied),
      takeover,
      lateOldReconnect,
      partial,
    },
  };
}

async function observeRelease(
  boundary: V1OwnerBoundary,
  namespace: string,
): Promise<V1AxisObservation> {
  const violations: string[] = [];
  const staleResults: Record<string, number | boolean | null> = {};
  for (const operation of ["renew", "status", "effect", "release"] as const) {
    const sessionId = `${namespace}-stale-${operation}`;
    await boundary.resetSession(sessionId);
    const owner = await createCandidate(`stale-${operation}`);
    const first = await boundary.acquire(
      acquireInput(sessionId, 1, owner.identity, "v5"),
    );
    const successor = await boundary.acquire({
      ...acquireInput(sessionId, 2, owner.identity, "v5"),
      acquiredAt: AFTER_EXPIRY,
      leaseExpiresAt: NEXT_LEASE,
    });
    if (!first.applied || !successor.applied || successor.generation === first.generation) {
      violations.push(`${operation}:successor_generation_unavailable`);
      staleResults[operation] = null;
      continue;
    }
    const staleGeneration = first.generation!;
    const applied = operation === "renew"
      ? await boundary.renew(sessionId, staleGeneration, owner.identity, NEXT_LEASE)
      : operation === "status"
        ? await boundary.writeStatus(sessionId, staleGeneration, "error")
        : operation === "effect"
          ? await boundary.writeEffect(sessionId, staleGeneration)
          : (await boundary.release(
              sessionId,
              staleGeneration,
              owner.identity.executionCommandId,
            )).appliedRows;
    staleResults[operation] = applied;
    if (applied !== 0) violations.push(`stale_${operation}:generation_fence_missing`);
  }

  const atomicSessionId = `${namespace}-release-atomic`;
  await boundary.resetSession(atomicSessionId);
  const atomicOwner = await createCandidate("release-atomic");
  const atomicAcquire = await boundary.acquire(
    acquireInput(atomicSessionId, 1, atomicOwner.identity, "v5"),
  );
  const fault = await boundary.release(
    atomicSessionId,
    atomicAcquire.generation ?? 1,
    atomicOwner.identity.executionCommandId,
    { faultAfterTerminal: true },
  );
  const afterFault = await boundary.snapshot(atomicSessionId);
  if (!fault.supported) violations.push("release_fault_probe_unavailable");
  if (afterFault.status !== "running" || afterFault.identity === null) {
    violations.push("release_partial_state_visible");
  }
  const released = await boundary.release(
    atomicSessionId,
    atomicAcquire.generation ?? 1,
    atomicOwner.identity.executionCommandId,
  );
  const afterRelease = await boundary.snapshot(atomicSessionId);
  if (!afterRelease.ownerStoredOnSessionsRow) violations.push("owner_not_on_sessions_row");
  if (released.appliedRows !== 1) violations.push("current_release_not_applied");
  if (afterRelease.status !== "completed") violations.push("terminal_projection_missing");
  if (afterRelease.identity !== null) violations.push("owner_not_cleared");

  const dormantSessionId = `${namespace}-runner-absent-dormant`;
  await boundary.resetSession(dormantSessionId);
  const dormant = await boundary.snapshot(dormantSessionId);
  const terminalAbsence = absenceState(afterRelease);
  const dormantAbsence = absenceState(dormant);
  if (terminalAbsence !== "released_terminal") {
    violations.push(`terminal_runner_absence_ambiguous:${terminalAbsence}`);
  }
  if (dormantAbsence !== "dormant_without_owner") {
    violations.push(`dormant_runner_absence_ambiguous:${dormantAbsence}`);
  }

  return {
    axis: "release",
    violations,
    diagnostic: {
      boundary: boundary.label,
      staleResults,
      fault,
      afterFault: compactSnapshot(afterFault),
      released,
      afterRelease: compactSnapshot(afterRelease),
      absenceStates: [terminalAbsence, dormantAbsence],
    },
  };
}

interface Candidate {
  identity: CompleteIdentity;
  inputs: string[];
  runInput(prompt: string): Promise<void>;
  prepareNextFrameCommand(): Promise<string>;
}

async function createCandidate(label: string): Promise<Candidate> {
  const inputs: string[] = [];
  const engine: EnginePort = {
    backendId: "codex",
    workspaceDir: "/tmp/v1-owner-red",
    async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
      inputs.push(params.prompt);
      yield { type: "complete", timestamp: 1 } as SSEEventPayload;
    },
    async interrupt() { return true; },
    async close() {},
  };
  const dispatcher = new InProcessRunnerCommandDispatcher(engine);
  const proof = await dispatcher.prepareExecutionIdentity(`owner-token:${label}`);
  return {
    identity: {
      manifestId: `manifest:${label}`,
      runtimeEnvIdentity: `runtime:${label}`,
      registrationId: proof.registrationId,
      pid: proof.pid,
      startIdentity: proof.startIdentity,
      executionCommandId: proof.executionCommandId,
    },
    inputs,
    async runInput(prompt: string) {
      for await (const _frame of dispatcher.executeFrames({
        agentSessionId: `session:${label}`,
        prompt,
      })) {
        // Draining the real dispatcher is the observable engine-input boundary.
      }
    },
    async prepareNextFrameCommand() {
      return (await dispatcher.prepareExecutionIdentity()).executionCommandId;
    },
  };
}

function acquireInput(
  sessionId: string,
  candidateGeneration: number,
  identity: CompleteIdentity,
  path: AcquirePath,
  raceKey?: string,
) {
  return {
    sessionId,
    candidateGeneration,
    identity,
    acquiredAt: BASE_TIME,
    leaseExpiresAt: LEASE,
    path,
    ...(raceKey ? { raceKey } : {}),
  };
}

function sameIdentity(
  actual: CompleteIdentity | null,
  expected: CompleteIdentity,
): boolean {
  return actual !== null
    && actual.manifestId === expected.manifestId
    && actual.runtimeEnvIdentity === expected.runtimeEnvIdentity
    && actual.registrationId === expected.registrationId
    && actual.pid === expected.pid
    && actual.startIdentity === expected.startIdentity
    && actual.executionCommandId === expected.executionCommandId;
}

function absenceState(snapshot: OwnerSnapshot): string {
  if (snapshot.identity !== null) return "owner_present";
  return ["completed", "error", "interrupted"].includes(snapshot.status)
    ? "released_terminal"
    : "dormant_without_owner";
}

function compactSnapshot(snapshot: OwnerSnapshot): Record<string, unknown> {
  return {
    status: snapshot.status,
    generation: snapshot.generation,
    owner: snapshot.identity?.executionCommandId ?? null,
    ownerStoredOnSessionsRow: snapshot.ownerStoredOnSessionsRow,
  };
}
