import { LIVE_OWNER_IDENTITY } from
  "./ownerless_running_reconciliation_fixture.js";

export interface LegacyOwnerlessRowSnapshot {
  status: string;
  terminationReason: string | null;
  terminationDetail: string | null;
  terminationEventId: number | null;
  generation: number;
  manifestId: string | null;
  runtimeEnvIdentity: string | null;
  registrationId: string | null;
  pid: number | null;
  startIdentity: string | null;
  executionCommandId: string | null;
  leaseExpiresAt: Date | null;
  activeOwnershipRows: number;
  terminalEventCount: number;
}

export interface LegacyGen0OwnerlessMatrixObservation {
  inventorySessionIds: string[];
  scanPhases: ["startup", "reconnect"];
  gen0NoOwnershipRow: LegacyOwnerlessRowSnapshot;
  genPositiveClosedOwner: LegacyOwnerlessRowSnapshot;
  fullProvenLiveOwner: LegacyOwnerlessRowSnapshot;
  terminalControl: LegacyOwnerlessRowSnapshot;
  terminalControlInitialEventCount: number;
  ownerlessRunningCount: number;
  statusOnlyTerminalWrites: number;
}

export type LegacyGen0OwnerlessMutation =
  | "skip_gen0"
  | "exclude_no_ownership_row"
  | "status_only_terminal_writer";

export const LEGACY_GEN0_MUTATION_EXPECTATIONS: Record<
  LegacyGen0OwnerlessMutation,
  string
> = {
  skip_gen0: "ROW_A_GEN0_NO_OWNERSHIP_ROW_DID_NOT_CONVERGE",
  exclude_no_ownership_row: "ROW_A_NO_OWNERSHIP_ROW_EXCLUDED_FROM_INVENTORY",
  status_only_terminal_writer: "ROW_A_STATUS_ONLY_TERMINAL_WRITE",
};

export function legacyGen0OwnerlessViolations(
  observation: LegacyGen0OwnerlessMatrixObservation,
): string[] {
  const rowA = observation.gen0NoOwnershipRow;
  const rowB = observation.genPositiveClosedOwner;
  const rowC = observation.fullProvenLiveOwner;
  const rowD = observation.terminalControl;
  return compact([
    !observation.inventorySessionIds.includes("legacy-gen0-no-ownership-row")
      ? "ROW_A_NO_OWNERSHIP_ROW_EXCLUDED_FROM_INVENTORY"
      : null,
    observation.scanPhases[0] !== "startup"
      || observation.scanPhases[1] !== "reconnect"
      ? "ROW_A_STARTUP_RECONNECT_PROOF_MISSING"
      : null,
    !isTerminal(rowA.status)
      ? "ROW_A_GEN0_NO_OWNERSHIP_ROW_DID_NOT_CONVERGE"
      : null,
    rowA.status !== "running" && !hasCanonicalTerminalEvidence(rowA)
      ? "ROW_A_STATUS_ONLY_TERMINAL_WRITE"
      : null,
    rowA.generation !== 0 || hasSessionOwner(rowA) || rowA.activeOwnershipRows !== 0
      ? "ROW_A_GEN0_TERMINAL_RETAINED_OWNER_EVIDENCE"
      : null,
    !isTerminal(rowB.status)
      || !hasCanonicalTerminalEvidence(rowB)
      || rowB.activeOwnershipRows !== 0
      ? "ROW_B_GEN_POSITIVE_CLOSED_OWNER_DID_NOT_CONVERGE"
      : null,
    !isExactProvenLiveOwner(rowC)
      ? "ROW_C_FULL_PROVEN_LIVE_OWNER_NOT_PRESERVED"
      : null,
    !isTerminal(rowD.status)
      || !hasCanonicalTerminalEvidence(rowD)
      || rowD.terminalEventCount !== observation.terminalControlInitialEventCount
      ? "ROW_D_TERMINAL_CONTROL_CHANGED"
      : null,
    observation.ownerlessRunningCount !== 0
      ? "MATRIX_OWNERLESS_RUNNING_NOT_ZERO"
      : null,
    observation.statusOnlyTerminalWrites !== 0
      ? "MATRIX_STATUS_ONLY_TERMINAL_WRITE"
      : null,
  ]);
}

export function idealLegacyGen0OwnerlessMatrix(): LegacyGen0OwnerlessMatrixObservation {
  return {
    inventorySessionIds: ["legacy-gen0-no-ownership-row"],
    scanPhases: ["startup", "reconnect"],
    gen0NoOwnershipRow: terminalSnapshot(0),
    genPositiveClosedOwner: terminalSnapshot(1),
    fullProvenLiveOwner: liveOwnerSnapshot(),
    terminalControl: terminalSnapshot(0),
    terminalControlInitialEventCount: 1,
    ownerlessRunningCount: 0,
    statusOnlyTerminalWrites: 0,
  };
}

export function applyLegacyGen0OwnerlessMutation(
  baseline: LegacyGen0OwnerlessMatrixObservation,
  mutation: LegacyGen0OwnerlessMutation,
): LegacyGen0OwnerlessMatrixObservation {
  const mutated = structuredClone(baseline);
  if (mutation === "skip_gen0") {
    mutated.gen0NoOwnershipRow = runningOwnerlessSnapshot(0);
    mutated.ownerlessRunningCount = 1;
  }
  if (mutation === "exclude_no_ownership_row") {
    mutated.inventorySessionIds = [];
  }
  if (mutation === "status_only_terminal_writer") {
    mutated.gen0NoOwnershipRow = {
      ...terminalSnapshot(0),
      terminationReason: null,
      terminationDetail: null,
      terminationEventId: null,
      terminalEventCount: 0,
    };
    mutated.statusOnlyTerminalWrites = 1;
  }
  return mutated;
}

function terminalSnapshot(generation: number): LegacyOwnerlessRowSnapshot {
  return {
    status: "interrupted",
    terminationReason: "unknown",
    terminationDetail: "owner-null running migration could not prove a stable runner identity",
    terminationEventId: 101,
    generation,
    manifestId: null,
    runtimeEnvIdentity: null,
    registrationId: null,
    pid: null,
    startIdentity: null,
    executionCommandId: null,
    leaseExpiresAt: null,
    activeOwnershipRows: 0,
    terminalEventCount: 1,
  };
}

function runningOwnerlessSnapshot(generation: number): LegacyOwnerlessRowSnapshot {
  return {
    ...terminalSnapshot(generation),
    status: "running",
    terminationReason: null,
    terminationDetail: null,
    terminationEventId: null,
    terminalEventCount: 0,
  };
}

function liveOwnerSnapshot(): LegacyOwnerlessRowSnapshot {
  return {
    status: "running",
    terminationReason: null,
    terminationDetail: null,
    terminationEventId: null,
    generation: 1,
    manifestId: LIVE_OWNER_IDENTITY.manifestId,
    runtimeEnvIdentity: LIVE_OWNER_IDENTITY.runtimeEnvIdentity,
    registrationId: LIVE_OWNER_IDENTITY.registrationId,
    pid: LIVE_OWNER_IDENTITY.pid,
    startIdentity: LIVE_OWNER_IDENTITY.startIdentity,
    executionCommandId: LIVE_OWNER_IDENTITY.executionCommandId,
    leaseExpiresAt: new Date("2026-08-28T00:02:00.000Z"),
    activeOwnershipRows: 1,
    terminalEventCount: 0,
  };
}

function hasCanonicalTerminalEvidence(snapshot: LegacyOwnerlessRowSnapshot): boolean {
  return isTerminal(snapshot.status)
    && typeof snapshot.terminationReason === "string"
    && snapshot.terminationReason.length > 0
    && typeof snapshot.terminationDetail === "string"
    && snapshot.terminationDetail.length > 0
    && Number.isSafeInteger(snapshot.terminationEventId)
    && snapshot.terminationEventId! > 0
    && snapshot.terminalEventCount === 1;
}

function isExactProvenLiveOwner(snapshot: LegacyOwnerlessRowSnapshot): boolean {
  return snapshot.status === "running"
    && snapshot.generation > 0
    && snapshot.manifestId === LIVE_OWNER_IDENTITY.manifestId
    && snapshot.runtimeEnvIdentity === LIVE_OWNER_IDENTITY.runtimeEnvIdentity
    && snapshot.registrationId === LIVE_OWNER_IDENTITY.registrationId
    && snapshot.pid === LIVE_OWNER_IDENTITY.pid
    && snapshot.startIdentity === LIVE_OWNER_IDENTITY.startIdentity
    && snapshot.executionCommandId === LIVE_OWNER_IDENTITY.executionCommandId
    && snapshot.leaseExpiresAt instanceof Date
    && Number.isFinite(snapshot.leaseExpiresAt.getTime())
    && snapshot.activeOwnershipRows === 1
    && snapshot.terminationEventId === null;
}

function hasSessionOwner(snapshot: LegacyOwnerlessRowSnapshot): boolean {
  return snapshot.manifestId !== null
    || snapshot.runtimeEnvIdentity !== null
    || snapshot.registrationId !== null
    || snapshot.pid !== null
    || snapshot.startIdentity !== null
    || snapshot.executionCommandId !== null
    || snapshot.leaseExpiresAt !== null;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}
