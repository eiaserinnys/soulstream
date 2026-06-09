export const SUPERVISOR_WAKE_ALLOWED_CALLER_SOURCES: ReadonlySet<string> = new Set([
  "browser",
  "slack",
  "soul-app",
  "agent",
]);

export interface SupervisorWakeSourceCandidate {
  supervisorId: string;
  sourceAgentId?: string | null;
  callerSource?: string | null;
  critical: boolean;
}

export function shouldDispatchSupervisorWakeCandidate(
  candidate: SupervisorWakeSourceCandidate,
): boolean {
  if (candidate.sourceAgentId === candidate.supervisorId) return false;
  if (candidate.critical) return true;
  return typeof candidate.callerSource === "string" &&
    SUPERVISOR_WAKE_ALLOWED_CALLER_SOURCES.has(candidate.callerSource);
}

export function hasCriticalSupervisorSnapshotSignal(params: {
  status?: string | null;
}): boolean {
  return params.status === "error";
}
