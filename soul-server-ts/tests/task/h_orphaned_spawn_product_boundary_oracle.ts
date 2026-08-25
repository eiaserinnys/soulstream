export type HProductBoundaryMutation =
  | "orphan_child_survives"
  | "identity_evidence_splits"
  | "weaken_fail_closed_identity_check"
  | "followup_delivery_blocks"
  | "model_and_user_outcome_missing"
  | "unsafe_replacement_spawn";

export type HProductBoundaryRepair =
  | "terminate_spawned_child"
  | "settle_identity_owner"
  | "restore_delivery"
  | "surface_model_or_user_outcome"
  | "preserve_single_spawn_and_existing_runner";

export type HProductBoundaryViolation =
  | "spawn_not_exactly_once"
  | "live_unowned_child"
  | "identity_evidence_not_single_owner"
  | "followup_delivery_blocked"
  | "message_not_delivered_or_visible_failure"
  | "existing_runner_killed";

export interface HIdentityEvidence {
  pidFilePid: number | null;
  identityPid: number | null;
  lifecyclePid: number | null;
}

export interface HMessageObservation {
  messageId: string;
  outcome: "delivered" | "visible_failure" | "not_observed_by_model_or_user";
}

export interface HProductBoundaryObservation {
  spawnCount: number;
  liveUnownedChildPids: number[];
  identityEvidence: HIdentityEvidence;
  followupDeliveryErrors: string[];
  messages: HMessageObservation[];
  killedExistingRunnerPids: number[];
}

export interface HContractAssertionResult {
  assertion: HProductBoundaryViolation;
  passes: boolean;
}

interface HContractAssertion {
  name: HProductBoundaryViolation;
  isViolated: (observation: HProductBoundaryObservation) => boolean;
}

const CONTRACT_ASSERTIONS: readonly HContractAssertion[] = [
  {
    name: "spawn_not_exactly_once",
    isViolated: (observation) => observation.spawnCount !== 1,
  },
  {
    name: "live_unowned_child",
    isViolated: (observation) => observation.liveUnownedChildPids.length !== 0,
  },
  {
    name: "identity_evidence_not_single_owner",
    isViolated: (observation) => identityOwnerCount(observation.identityEvidence) !== 1,
  },
  {
    name: "followup_delivery_blocked",
    isViolated: (observation) => observation.followupDeliveryErrors.length !== 0,
  },
  {
    name: "message_not_delivered_or_visible_failure",
    isViolated: (observation) => observation.messages.length === 0
      || observation.messages.some(
        (message) => message.outcome === "not_observed_by_model_or_user",
      ),
  },
  {
    name: "existing_runner_killed",
    isViolated: (observation) => observation.killedExistingRunnerPids.length !== 0,
  },
];

export function hProductBoundaryAssertionResults(
  observation: HProductBoundaryObservation,
): HContractAssertionResult[] {
  return CONTRACT_ASSERTIONS.map((assertion) => ({
    assertion: assertion.name,
    passes: !assertion.isViolated(observation),
  }));
}

export function hProductBoundaryViolations(
  observation: HProductBoundaryObservation,
): HProductBoundaryViolation[] {
  return hProductBoundaryAssertionResults(observation)
    .filter((result) => !result.passes)
    .map((result) => result.assertion);
}

export function idealHProductBoundaryObservation(input: {
  authoritativeOwnerPid: number;
  messageId: string;
}): HProductBoundaryObservation {
  return {
    spawnCount: 1,
    liveUnownedChildPids: [],
    identityEvidence: singleOwnerEvidence(input.authoritativeOwnerPid),
    followupDeliveryErrors: [],
    messages: [{ messageId: input.messageId, outcome: "visible_failure" }],
    killedExistingRunnerPids: [],
  };
}

export function productFixedHProductBoundaryCounterfactual(
  observation: HProductBoundaryObservation,
  input: { authoritativeOwnerPid: number; messageId: string },
): HProductBoundaryObservation {
  const observedMessage = observation.messages.find(
    (message) => message.messageId === input.messageId,
  );
  return {
    ...observation,
    spawnCount: 1,
    liveUnownedChildPids: [],
    identityEvidence: singleOwnerEvidence(input.authoritativeOwnerPid),
    followupDeliveryErrors: [],
    messages: [{
      messageId: input.messageId,
      outcome: observedMessage?.outcome === "delivered" ? "delivered" : "visible_failure",
    }],
    killedExistingRunnerPids: [],
  };
}

export function applyHProductBoundaryRepair(
  observation: HProductBoundaryObservation,
  repair: HProductBoundaryRepair,
  input: { authoritativeOwnerPid: number; messageId: string },
): HProductBoundaryObservation {
  switch (repair) {
    case "terminate_spawned_child":
      return { ...observation, liveUnownedChildPids: [] };
    case "settle_identity_owner":
      return {
        ...observation,
        identityEvidence: singleOwnerEvidence(input.authoritativeOwnerPid),
      };
    case "restore_delivery":
      return { ...observation, followupDeliveryErrors: [] };
    case "surface_model_or_user_outcome":
      return {
        ...observation,
        messages: [{ messageId: input.messageId, outcome: "visible_failure" }],
      };
    case "preserve_single_spawn_and_existing_runner":
      return {
        ...observation,
        spawnCount: 1,
        killedExistingRunnerPids: [],
      };
  }
}

export function applyHProductBoundaryMutation(
  observation: HProductBoundaryObservation,
  mutation: HProductBoundaryMutation,
): HProductBoundaryObservation {
  const ownerPid = firstIdentityOwner(observation.identityEvidence) ?? 7_201;
  switch (mutation) {
    case "orphan_child_survives":
      return { ...observation, liveUnownedChildPids: [ownerPid + 1] };
    case "identity_evidence_splits":
    case "weaken_fail_closed_identity_check":
      return {
        ...observation,
        identityEvidence: {
          pidFilePid: ownerPid + 1,
          identityPid: ownerPid + 1,
          lifecyclePid: ownerPid,
        },
      };
    case "followup_delivery_blocks":
      return {
        ...observation,
        followupDeliveryErrors: ["runner pid evidence disagrees"],
      };
    case "model_and_user_outcome_missing":
      return {
        ...observation,
        messages: observation.messages.map((message) => ({
          ...message,
          outcome: "not_observed_by_model_or_user" as const,
        })),
      };
    case "unsafe_replacement_spawn":
      return {
        ...observation,
        spawnCount: 2,
        killedExistingRunnerPids: [ownerPid],
      };
  }
}

function singleOwnerEvidence(ownerPid: number): HIdentityEvidence {
  return {
    pidFilePid: null,
    identityPid: null,
    lifecyclePid: ownerPid,
  };
}

function identityOwnerCount(evidence: HIdentityEvidence): number {
  return new Set(
    Object.values(evidence).filter((pid): pid is number => pid !== null),
  ).size;
}

function firstIdentityOwner(evidence: HIdentityEvidence): number | null {
  return evidence.lifecyclePid ?? evidence.identityPid ?? evidence.pidFilePid;
}
