export const ORCHESTRATION_PROFILE_ID = "ariella-orchestrator";
export const ORCHESTRATION_PURPOSE_TYPE = "card_orchestration_decision";

/** Server-owned authority marker. Never forwarded from generic session input. */
export type OrchestrationPurpose = {
  readonly runId: string;
  /** Stable execution fence assigned by the durable run, not the renewable lease token. */
  readonly leaseToken: string;
  readonly instructionsRevision: string;
};
type PurposeTask = {
  readonly profileId?: string;
  readonly orchestrationPurpose?: OrchestrationPurpose;
  readonly metadata?: readonly Record<string, unknown>[];
};
export function validOrchestrationPurpose(value: unknown): value is OrchestrationPurpose {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [record.runId, record.leaseToken, record.instructionsRevision]
    .every(field => typeof field === "string" && field.trim().length > 0);
}
export function isOrchestrationDecisionTask(task: PurposeTask): boolean {
  return task.profileId === ORCHESTRATION_PROFILE_ID || task.orchestrationPurpose !== undefined
    || task.metadata?.some(entry => entry?.type === ORCHESTRATION_PURPOSE_TYPE) === true;
}
export function assertGenericTaskExecution(task: PurposeTask, agentId?: string): void {
  if (isOrchestrationDecisionTask(task) || agentId === ORCHESTRATION_PROFILE_ID) {
    throw new Error("card orchestration decision sessions require the dedicated isolated executor");
  }
}
export function assertOrchestrationCreation(params: PurposeTask & { sessionType?: string }): void {
  if (params.orchestrationPurpose !== undefined) {
    if (!validOrchestrationPurpose(params.orchestrationPurpose) || params.sessionType !== "llm") {
      throw new Error("card orchestration purpose requires a valid server marker and llm session");
    }
  } else if (params.profileId === ORCHESTRATION_PROFILE_ID) {
    throw new Error("card orchestration profile requires a server-owned purpose marker");
  }
}
export function orchestrationPurposeFromMetadata(
  metadata: readonly Record<string, unknown>[],
): OrchestrationPurpose | null | undefined {
  const entries = metadata.filter(entry => entry?.type === ORCHESTRATION_PURPOSE_TYPE);
  if (entries.length === 0) return undefined;
  if (entries.length !== 1 || !validOrchestrationPurpose(entries[0])) return null;
  const { runId, leaseToken, instructionsRevision } = entries[0];
  return { runId, leaseToken, instructionsRevision };
}
