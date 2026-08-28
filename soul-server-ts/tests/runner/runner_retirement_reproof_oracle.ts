export type RetirementReproofRow = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface RetirementReproofObservation {
  row: RetirementReproofRow;
  disposition?: string;
  events: string[];
  errors: string[];
  freshExactReproofCount: number;
  startIdentityCompared: boolean;
  unrelatedPidSignalCount: number;
  evidencePreservedAfterRecoverableFailure: boolean;
  allIrreversibleEventsInsideSessionLock: boolean;
  compatibleIdentityRetained: boolean;
  pendingDeliveryPreserved: boolean;
  secondRequestConsumed: boolean;
  retryHorizonStable: boolean;
  resumeStatus: "completed" | "error";
  counts: {
    liveRunner: number;
    writer: number;
    registration: number;
    executionOwner: number;
    generation: number;
    terminate: number;
    exitProof: number;
    replay: number;
    retire: number;
    spawn: number;
    delivery: number;
    terminal: number;
    notification: number;
    consume: number;
    modelTurn: number;
  };
}

export const mutationViolationByName = {
  "final-liveness-reproof-removed": "row-4-final-liveness-reproof-missing",
  "identity-retired-before-terminate-exit-proof": "row-4-retire-preceded-exit-proof",
  "terminate-failure-cleared-identity":
    "row-7-recoverable-failure-erased-registration-evidence",
  "start-identity-comparison-removed-pid-only-kill": "row-9-pid-only-kill-risk",
  "retire-spawn-outside-session-mutation-lock":
    "row-8-retire-or-spawn-escaped-session-lock",
} as const;

export type RetirementReproofMutation = keyof typeof mutationViolationByName;

export function retirementReproofViolations(
  observation: RetirementReproofObservation,
): string[] {
  const order = (name: string) => observation.events.indexOf(name);
  const retired = order("retire") >= 0;
  const terminationRequired = observation.events.includes("process-live-at-final-boundary");
  const exitBeforeRetire = !retired || (
    order("exit-proof") >= 0 && order("exit-proof") < order("retire")
  );
  const terminatedBeforeRetire = !terminationRequired || !retired || (
    order("terminate") >= 0 && order("terminate") < order("retire")
  );
  const namedRuntimeErrors = observation.errors.filter((message) =>
    /writer lock already held|process identity unavailable|engine unavailable|orphan|stale owner/i
      .test(message));
  const exactlyOneSemantic = observation.row === 3 || observation.row === 8
    ? observation.counts.delivery === 1
      && observation.counts.terminal === 1
      && observation.counts.notification === 1
      && observation.counts.consume === 1
      && observation.counts.modelTurn === 1
    : true;
  return compact([
    observation.resumeStatus !== "completed"
      ? `row-${observation.row}-explicit-resume-not-completed`
      : null,
    namedRuntimeErrors.length > 0
      ? `row-${observation.row}-forbidden-runtime-error`
      : null,
    observation.counts.liveRunner > 1
      || observation.counts.writer > 1
      || observation.counts.registration > 1
      || observation.counts.executionOwner > 1
      || observation.counts.generation > 1
      ? `row-${observation.row}-canonical-owner-count-exceeded-one`
      : null,
    observation.counts.spawn > 1 || observation.counts.replay > 1
      ? `row-${observation.row}-retry-produced-duplicate-work`
      : null,
    !observation.retryHorizonStable
      ? `row-${observation.row}-retry-horizon-not-stable`
      : null,
    !exactlyOneSemantic
      ? `row-${observation.row}-semantic-effect-not-exactly-once`
      : null,
    observation.row === 1 && !observation.compatibleIdentityRetained
      ? "row-1-compatible-runner-not-retained"
      : null,
    observation.row === 1 && (
      observation.counts.terminate !== 0
      || observation.counts.retire !== 0
      || observation.counts.spawn !== 0
    ) ? "row-1-compatible-runner-was-replaced" : null,
    observation.row === 2 && (
      observation.counts.spawn !== 1 || observation.counts.generation !== 1
    ) ? "row-2-proven-dead-resume-did-not-create-one-successor" : null,
    observation.row === 3 && (
      observation.counts.replay !== 1 || observation.counts.retire !== 1
    ) ? "row-3-terminal-fact-not-replayed-and-retired-once" : null,
    observation.row === 4 && observation.freshExactReproofCount < 1
      ? "row-4-final-liveness-reproof-missing"
      : null,
    observation.row === 4 && !terminatedBeforeRetire
      ? "row-4-retire-preceded-exact-termination"
      : null,
    observation.row === 4 && !exitBeforeRetire
      ? "row-4-retire-preceded-exit-proof"
      : null,
    observation.row === 5 && observation.unrelatedPidSignalCount !== 0
      ? "row-5-natural-exit-signalled-unrelated-process"
      : null,
    observation.row === 5 && observation.counts.retire !== 1
      ? "row-5-natural-exit-not-retired-after-death-proof"
      : null,
    observation.row === 6 && !observation.evidencePreservedAfterRecoverableFailure
      ? "row-6-restart-lost-exact-registration-evidence"
      : null,
    observation.row === 6 && (
      observation.counts.retire !== 1 || observation.counts.spawn !== 1
    ) ? "row-6-restarted-host-did-not-finish-retire-and-spawn" : null,
    observation.row === 7 && !observation.evidencePreservedAfterRecoverableFailure
      ? "row-7-recoverable-failure-erased-registration-evidence"
      : null,
    observation.row === 8 && !observation.allIrreversibleEventsInsideSessionLock
      ? "row-8-retire-or-spawn-escaped-session-lock"
      : null,
    observation.row === 8 && (
      order("retire") < 0
      || order("spawn") < 0
      || order("retire") > order("spawn")
    ) ? "row-8-explicit-spawn-preceded-terminal-retirement" : null,
    observation.row === 8 && !observation.secondRequestConsumed
      ? "row-8-concurrent-explicit-request-not-consumed"
      : null,
    observation.row === 8 && (
      observation.counts.terminate > 1
      || observation.counts.replay !== 1
      || observation.counts.retire !== 1
      || observation.counts.spawn !== 1
      || observation.counts.generation !== 1
    ) ? "row-8-concurrent-boundary-not-exactly-once" : null,
    observation.row === 9 && (
      !observation.startIdentityCompared || observation.unrelatedPidSignalCount !== 0
    ) ? "row-9-pid-only-kill-risk" : null,
    observation.row === 10 && !observation.pendingDeliveryPreserved
      ? "row-10-incompatible-cutover-lost-pending-delivery"
      : null,
  ]);
}

export function applyRetirementReproofMutation(
  baseline: RetirementReproofObservation,
  mutation: RetirementReproofMutation,
): RetirementReproofObservation {
  if (mutation === "final-liveness-reproof-removed") {
    return { ...baseline, row: 4, freshExactReproofCount: 0 };
  }
  if (mutation === "identity-retired-before-terminate-exit-proof") {
    return {
      ...baseline,
      row: 4,
      events: ["process-live-at-final-boundary", "retire", "terminate", "exit-proof"],
    };
  }
  if (mutation === "terminate-failure-cleared-identity") {
    return { ...baseline, row: 7, evidencePreservedAfterRecoverableFailure: false };
  }
  if (mutation === "start-identity-comparison-removed-pid-only-kill") {
    return {
      ...baseline,
      row: 9,
      startIdentityCompared: false,
      unrelatedPidSignalCount: 1,
    };
  }
  return { ...baseline, row: 8, allIrreversibleEventsInsideSessionLock: false };
}

export function idealRetirementReproofObservation(
  row: RetirementReproofRow,
): RetirementReproofObservation {
  const baseline: RetirementReproofObservation = {
    row,
    disposition: row === 4 ? "replay_terminal_dead" : undefined,
    events: ["process-live-at-final-boundary", "fresh-exact-reproof", "terminate", "exit-proof", "retire", "spawn"],
    errors: [],
    freshExactReproofCount: 1,
    startIdentityCompared: true,
    unrelatedPidSignalCount: 0,
    evidencePreservedAfterRecoverableFailure: true,
    allIrreversibleEventsInsideSessionLock: true,
    compatibleIdentityRetained: true,
    pendingDeliveryPreserved: true,
    secondRequestConsumed: true,
    retryHorizonStable: true,
    resumeStatus: "completed",
    counts: {
      liveRunner: 1,
      writer: 1,
      registration: 1,
      executionOwner: 1,
      generation: 1,
      terminate: 1,
      exitProof: 1,
      replay: 1,
      retire: 1,
      spawn: 1,
      delivery: 1,
      terminal: 1,
      notification: 1,
      consume: 1,
      modelTurn: 1,
    },
  };
  if (row === 1) {
    return {
      ...baseline,
      events: ["process-live-at-final-boundary", "fresh-exact-reproof", "adopt"],
      counts: {
        ...baseline.counts,
        terminate: 0,
        exitProof: 0,
        replay: 0,
        retire: 0,
        spawn: 0,
      },
    };
  }
  if (row === 2 || row === 9) {
    return {
      ...baseline,
      events: ["fresh-exact-death-proof", "retire", "spawn"],
      counts: {
        ...baseline.counts,
        terminate: 0,
        exitProof: 1,
        replay: 0,
      },
    };
  }
  if (row === 5) {
    return {
      ...baseline,
      events: [
        "process-live-at-final-boundary",
        "fresh-exact-reproof",
        "natural-exit-before-signal",
        "exit-proof",
        "retire",
        "spawn",
      ],
      counts: { ...baseline.counts, terminate: 0 },
    };
  }
  return baseline;
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}
