import { createHash } from "node:crypto";
import type { ExecutionOwnershipObservation } from
  "../task/execution_ownership.js";

export function emptyExecutionOwnershipObservation(
  observedAt: Date,
): ExecutionOwnershipObservation {
  return {
    manifestId: null,
    runtimeEnvIdentity: null,
    registrationId: null,
    pid: null,
    startIdentity: null,
    executionCommandId: null,
    observedAt,
  };
}

export function executionOwnershipEvidenceHash(
  first: ExecutionOwnershipObservation,
  second: ExecutionOwnershipObservation,
): string {
  return createHash("sha256").update(JSON.stringify({
    first: serializableOwnershipObservation(first),
    second: serializableOwnershipObservation(second),
  })).digest("hex");
}

function serializableOwnershipObservation(
  observation: ExecutionOwnershipObservation,
): Record<string, string | number | null> {
  return {
    manifest_id: observation.manifestId,
    runtime_env_identity: observation.runtimeEnvIdentity,
    registration_id: observation.registrationId,
    pid: observation.pid,
    start_identity: observation.startIdentity,
    execution_command_id: observation.executionCommandId,
    observed_at: observation.observedAt.toISOString(),
  };
}
