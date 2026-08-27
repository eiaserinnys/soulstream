export type GenerationObservation = number | null | "unobserved";

export interface LiveV9AdoptObservation {
  adopted: boolean;
  userVersionAfterAdopt: number;
  mtimeUnchangedByAdopt: boolean;
  schemaUnchangedByAdopt: boolean;
  writerAppendAfterAdoptSucceeded: boolean;
}

export interface IdentityContinuityObservation {
  adoptedRegistrationIds: string[];
  expectedRegistrationId: string;
  newRunnerCount: number;
  projectedGenerations: GenerationObservation[];
}

export interface TerminalHarvestObservation {
  harvestErrors: string[];
  harvestedTail: Array<{ sourceSeq: number; eventType: string }>;
  expectedTail: Array<{ sourceSeq: number; eventType: string }>;
  duplicateCentralEventCount: number;
  terminalTransitionCount: number;
  centralStatus: "running" | "completed";
}

export interface FailSafeObservation {
  v9TailAdopted: boolean;
  v10ReadAdopted: boolean;
  v10TailAdopted: boolean;
  futureVersionRejected: boolean;
  futureVersionReturnedData: boolean;
  malformedV9Rejected: boolean;
  malformedV10Rejected: boolean;
  malformedReturnedData: boolean;
  rejectedSourcesUnchanged: boolean;
}

export interface CompatibilityMutationObservation {
  supportedVersions: number[];
  v9Accepted: boolean;
  v11Accepted: boolean;
  v9SourceMutated: boolean;
  projectedGeneration: GenerationObservation;
}

export function liveV9AdoptViolations(
  observation: LiveV9AdoptObservation,
): string[] {
  return compact([
    !observation.adopted ? "v9-live-read-only-adopt-rejected" : null,
    observation.userVersionAfterAdopt !== 9 ? "v9-reader-changed-user-version" : null,
    !observation.mtimeUnchangedByAdopt ? "v9-reader-changed-main-db-mtime" : null,
    !observation.schemaUnchangedByAdopt ? "v9-reader-changed-schema" : null,
    !observation.writerAppendAfterAdoptSucceeded ? "v9-reader-blocked-live-writer-append" : null,
  ]);
}

export function identityContinuityViolations(
  observation: IdentityContinuityObservation,
): string[] {
  const reusedTwice = observation.adoptedRegistrationIds.length === 2
    && observation.adoptedRegistrationIds.every(
      (registrationId) => registrationId === observation.expectedRegistrationId,
    );
  return compact([
    !reusedTwice ? "v9-registration-identity-not-reused-after-disconnect" : null,
    observation.newRunnerCount !== 0 ? "v9-re-adopt-spawned-successor" : null,
    observation.projectedGenerations.length !== 2
      ? "v9-generation-null-not-surfaced"
      : null,
    observation.projectedGenerations.some((generation) => generation !== null)
      ? "v9-generation-fabricated"
      : null,
  ]);
}

export function terminalHarvestViolations(
  observation: TerminalHarvestObservation,
): string[] {
  return compact([
    observation.harvestErrors.length > 0 ? "v9-terminal-harvest-failed" : null,
    !sameJson(observation.harvestedTail, observation.expectedTail)
      ? "v9-terminal-tail-mismatch"
      : null,
    observation.duplicateCentralEventCount !== 0
      ? "v9-terminal-tail-delivered-more-than-once"
      : null,
    observation.terminalTransitionCount !== 1
      ? "v9-central-terminal-transition-not-exactly-once"
      : null,
    observation.centralStatus !== "completed"
      ? "v9-central-session-not-completed"
      : null,
  ]);
}

export function failSafeViolations(observation: FailSafeObservation): string[] {
  return compact([
    !observation.v9TailAdopted ? "v9-read-only-tail-adopt-rejected" : null,
    !observation.v10ReadAdopted ? "v10-read-only-adopt-regressed" : null,
    !observation.v10TailAdopted ? "v10-read-only-tail-adopt-regressed" : null,
    !observation.futureVersionRejected ? "future-version-accepted" : null,
    observation.futureVersionReturnedData ? "future-version-exposed-data" : null,
    !observation.malformedV9Rejected ? "malformed-v9-schema-adopted" : null,
    !observation.malformedV10Rejected ? "malformed-v10-schema-adopted" : null,
    observation.malformedReturnedData ? "malformed-schema-exposed-data" : null,
    !observation.rejectedSourcesUnchanged ? "rejection-mutated-source" : null,
  ]);
}

export function compatibilityMutationViolations(
  observation: CompatibilityMutationObservation,
): string[] {
  return compact([
    !observation.supportedVersions.includes(9) ? "supported-set-dropped-v9" : null,
    !observation.supportedVersions.includes(10) ? "supported-set-dropped-v10" : null,
    observation.supportedVersions.some((version) => version > 10)
      ? "supported-set-includes-future-version"
      : null,
    !observation.v9Accepted ? "v9-read-support-missing" : null,
    observation.v11Accepted ? "future-version-accepted" : null,
    observation.v9SourceMutated ? "v9-reader-mutated-source" : null,
    typeof observation.projectedGeneration === "number"
      ? "v9-generation-fabricated"
      : null,
    observation.projectedGeneration === "unobserved"
      ? "v9-generation-null-not-surfaced"
      : null,
  ]);
}

export function newViolationNames(
  baseline: string[],
  mutated: string[],
): string[] {
  const baselineSet = new Set(baseline);
  return mutated.filter((name) => !baselineSet.has(name));
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
