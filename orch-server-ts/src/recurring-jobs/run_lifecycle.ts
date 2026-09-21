import {
  isActiveRecurringRun,
  type RecurringJob,
  type RecurringJobRepository,
  type RecurringJobRun,
} from "./types.js";

export type NewRecurringRunInput = {
  readonly trigger: RecurringJobRun["trigger"];
  readonly scheduledFor?: Date;
  readonly manualIdempotencyKey?: string;
  readonly state: RecurringJobRun["state"];
  readonly now: Date;
  readonly reason?: { readonly code: string; readonly message: string };
};

/** Creates the immutable execution intent stored before any node command. */
export function makeRecurringRun(
  job: RecurringJob,
  input: NewRecurringRunInput,
  newId: () => string,
): RecurringJobRun {
  const terminal = !isActiveRecurringRun(input.state);
  return {
    runId: newId(), jobId: job.jobId, trigger: input.trigger,
    scheduledFor: input.scheduledFor?.toISOString() ?? null,
    manualIdempotencyKey: input.manualIdempotencyKey ?? null,
    sessionId: newId(),
    jobSnapshot: {
      name: job.name, prompt: job.prompt, timezone: job.timezone,
      scheduleExpressions: job.scheduleExpressions, nodeId: job.nodeId, agentId: job.agentId,
      modelPreset: job.modelPreset, container: job.container, folderId: job.folderId,
      executionCaller: job.executionCaller, lateRunWindowSeconds: job.lateRunWindowSeconds,
    },
    state: input.state,
    reasonCode: input.reason?.code ?? null, reasonMessage: input.reason?.message ?? null,
    createdAt: input.now.toISOString(),
    startedAt: null,
    finishedAt: terminal ? input.now.toISOString() : null,
    updatedAt: input.now.toISOString(),
  };
}

/** Persists a state transition only if its observed source state is unchanged. */
export async function saveRecurringRun(
  repository: RecurringJobRepository,
  run: RecurringJobRun,
  state: RecurringJobRun["state"],
  now: Date,
  reason: { readonly code: string; readonly message: string } | null,
): Promise<RecurringJobRun> {
  const terminal = !isActiveRecurringRun(state);
  const saved = await repository.updateRun({
    ...run,
    state,
    reasonCode: reason?.code ?? null,
    reasonMessage: reason?.message ?? null,
    startedAt: state === "running" && !run.startedAt ? now.toISOString() : run.startedAt,
    finishedAt: terminal ? now.toISOString() : null,
    updatedAt: now.toISOString(),
  }, run.state);
  return saved ?? await repository.getRun(run.runId) ?? run;
}
