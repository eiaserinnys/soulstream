export const V1_OWNER_MUTATIONS = [
  "remove_for_update",
  "remove_generation_predicate",
  "remove_identity_check",
  "split_release_atomicity",
] as const;

export type V1OwnerMutation = (typeof V1_OWNER_MUTATIONS)[number];
export type AcquirePath = "v5" | "legacy_reserve" | "legacy_adopt";

export interface CompleteIdentity {
  manifestId: string;
  runtimeEnvIdentity: string;
  registrationId: string;
  pid: number;
  startIdentity: string;
  executionCommandId: string;
}

export interface AcquireInput {
  sessionId: string;
  candidateGeneration: number;
  identity: CompleteIdentity;
  acquiredAt: Date;
  leaseExpiresAt: Date;
  path: AcquirePath;
  raceKey?: string;
}

export interface AcquireResult {
  applied: boolean;
  generation: number | null;
}

export interface OwnerSnapshot {
  sessionId: string;
  status: string;
  terminalEventId: number | null;
  generation: number;
  identity: CompleteIdentity | null;
  leaseExpiresAt: Date | null;
  effectWrites: number;
  ownerStoredOnSessionsRow: boolean;
}

export interface PartialIdentityResult {
  supported: boolean;
  rejected: boolean;
  partialPersisted: boolean;
}

export interface ReleaseResult {
  supported: boolean;
  appliedRows: number;
  faulted: boolean;
}

export interface V1OwnerBoundary {
  readonly label: string;
  resetSession(sessionId: string, status?: string): Promise<void>;
  acquire(input: AcquireInput): Promise<AcquireResult>;
  renew(
    sessionId: string,
    generation: number,
    identity: CompleteIdentity,
    leaseExpiresAt: Date,
  ): Promise<number>;
  writeStatus(sessionId: string, generation: number, status: string): Promise<number>;
  writeEffect(sessionId: string, generation: number): Promise<number>;
  release(
    sessionId: string,
    generation: number,
    executionCommandId: string,
    options?: { faultAfterTerminal?: boolean },
  ): Promise<ReleaseResult>;
  injectPartialIdentity(sessionId: string): Promise<PartialIdentityResult>;
  snapshot(sessionId: string): Promise<OwnerSnapshot>;
}
