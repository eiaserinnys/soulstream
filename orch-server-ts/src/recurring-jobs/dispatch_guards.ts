import { RecurringJobError, type RecurringJob, type RecurringJobActor } from "./types.js";

export function schedulerActorFor(job: RecurringJob): RecurringJobActor {
  return {
    ownerEmail: job.ownerEmail,
    actorId: job.createdBy,
    callerInfo: { ...job.executionCaller },
    source: "scheduler",
  };
}

export function isUnavailableTarget(error: unknown): boolean {
  return error instanceof RecurringJobError && error.code === "NODE_UNAVAILABLE";
}

export function isConfirmedNodeReject(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "NODE_REJECTED" &&
    "dispatchPhase" in error && (error as { dispatchPhase?: unknown }).dispatchPhase === "after_send";
}

export function isUncertainLaunchFailure(error: unknown): boolean {
  if (isConfirmedNodeReject(error)) return false;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; dispatchPhase?: unknown; name?: unknown; response?: unknown };
  return candidate.dispatchPhase === "after_send" ||
    candidate.code === "TRANSPORT_SEND_FAILED" ||
    (candidate.name === "PendingNodeCommandRejectedError" && candidate.response === undefined);
}
