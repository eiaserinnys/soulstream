export type RecurringJobContainer = {
  readonly kind: "folder" | "task";
  readonly id: string;
};

export type RecurringJobRunTrigger = "scheduled" | "manual";

export type RecurringJobRunState =
  | "queued"
  | "waiting_for_node"
  | "dispatching"
  | "awaiting_session"
  | "running"
  | "completed"
  | "error"
  | "interrupted"
  | "skipped_overlap"
  | "skipped_late"
  | "cancelled";

export type RecurringJobActor = {
  readonly ownerEmail: string;
  readonly actorId: string;
  readonly callerInfo: Readonly<Record<string, unknown>>;
  readonly source: "browser" | "soul-app" | "agent" | "scheduler";
  readonly isAdmin?: boolean;
};

export type RecurringJob = {
  readonly jobId: string;
  readonly ownerEmail: string;
  readonly executionCaller: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly prompt: string;
  readonly scheduleExpressions: readonly string[];
  readonly timezone: string;
  readonly nodeId: string;
  readonly agentId: string;
  /** null means use the selected agent's default at run dispatch time. */
  readonly modelPreset: string | null;
  readonly container: RecurringJobContainer;
  readonly folderId: string;
  readonly enabled: boolean;
  readonly archivedAt: string | null;
  readonly lateRunWindowSeconds: number;
  readonly nextRunAt: string | null;
  readonly version: number;
  readonly createdIdempotencyKey: string;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RecurringJobRun = {
  readonly runId: string;
  readonly jobId: string;
  readonly trigger: RecurringJobRunTrigger;
  readonly scheduledFor: string | null;
  readonly manualIdempotencyKey: string | null;
  readonly sessionId: string;
  readonly jobSnapshot: Readonly<Record<string, unknown>>;
  readonly state: RecurringJobRunState;
  readonly reasonCode: string | null;
  readonly reasonMessage: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
};

export type RecurringJobCreateInput = {
  readonly idempotencyKey: string;
  readonly name: string;
  readonly prompt: string;
  readonly timezone: string;
  readonly scheduleExpressions: readonly string[];
  readonly nodeId: string;
  readonly agentId: string;
  readonly modelPreset: string | null;
  readonly container: RecurringJobContainer;
  readonly folderId: string;
  readonly lateRunWindowSeconds?: number;
  /** false stages a job safely before its first automatic occurrence. */
  readonly enabled?: boolean;
};

export type RecurringJobUpdateInput = {
  readonly expectedVersion: number;
  readonly name?: string;
  readonly prompt?: string;
  readonly timezone?: string;
  readonly scheduleExpressions?: readonly string[];
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly modelPreset?: string | null;
  readonly container?: RecurringJobContainer;
  readonly folderId?: string;
  readonly enabled?: boolean;
  readonly lateRunWindowSeconds?: number;
};

export type RecurringRunCreation = {
  readonly run: RecurringJobRun;
  readonly created: boolean;
};

export type RecurringJobConflict = {
  readonly code: "VERSION_CONFLICT";
  readonly job: RecurringJob;
};

export class RecurringJobError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "VALIDATION"
      | "VERSION_CONFLICT"
      | "ARCHIVED"
      | "NODE_UNAVAILABLE"
      | "SESSION_ID_MISMATCH",
    message: string,
    readonly statusCode: number,
    readonly currentJob?: RecurringJob,
  ) {
    super(message);
    this.name = "RecurringJobError";
  }
}

export interface RecurringJobRepository {
  findJobForOwner(jobId: string, ownerEmail: string, includeArchived?: boolean): Promise<RecurringJob | null>;
  listJobsForOwner(ownerEmail: string, includeArchived?: boolean): Promise<RecurringJob[]>;
  createJob(input: RecurringJob): Promise<RecurringJob>;
  findJobByCreateIdempotency(ownerEmail: string, idempotencyKey: string): Promise<RecurringJob | null>;
  updateJob(input: RecurringJob, expectedVersion: number): Promise<RecurringJob | RecurringJobConflict>;
  archiveJob(jobId: string, ownerEmail: string, expectedVersion: number, actorId: string, now: Date): Promise<RecurringJob | RecurringJobConflict | null>;
  listRuns(jobId: string, limit: number): Promise<RecurringJobRun[]>;
  findRunByManualIdempotency(jobId: string, idempotencyKey: string): Promise<RecurringJobRun | null>;
  findActiveRun(jobId: string): Promise<RecurringJobRun | null>;
  createManualRun(input: RecurringJobRun): Promise<RecurringRunCreation>;
  listDueJobs(now: Date, limit: number): Promise<RecurringJob[]>;
  listActiveRuns(limit: number): Promise<RecurringJobRun[]>;
  getJob(jobId: string): Promise<RecurringJob | null>;
  getRun(runId: string): Promise<RecurringJobRun | null>;
  getRunBySessionId(sessionId: string): Promise<RecurringJobRun | null>;
  updateRun(run: RecurringJobRun): Promise<RecurringJobRun>;
  reserveScheduledRun(input: {
    readonly job: RecurringJob;
    readonly run: RecurringJobRun;
    readonly nextRunAt: Date | null;
    readonly now: Date;
  }): Promise<RecurringRunCreation | null>;
  cancelAutomaticPendingRuns(jobId: string, reason: { code: string; message: string }, now: Date): Promise<void>;
  createScheduledRun(input: RecurringJobRun): Promise<RecurringRunCreation>;
  advanceJobNextRun(jobId: string, expectedVersion: number, nextRunAt: Date | null, now: Date): Promise<void>;
}

export type RecurringSessionLaunch = {
  readonly job: RecurringJob;
  readonly run: RecurringJobRun;
};

export type RecurringSessionLaunchResult = {
  readonly state: "awaiting_session" | "running";
  readonly resolvedModelPreset: string | null;
};

export type RecurringSessionLauncher = {
  readonly isNodeConnected: (nodeId: string) => boolean;
  readonly createRecurringSession: (input: RecurringSessionLaunch) => Promise<RecurringSessionLaunchResult>;
  readonly findDurableSession: (sessionId: string) => Promise<{
    readonly status: "initializing" | "running" | "completed" | "error" | "interrupted";
  } | null>;
};

export const ACTIVE_RECURRING_RUN_STATES = new Set<RecurringJobRunState>([
  "queued",
  "waiting_for_node",
  "dispatching",
  "awaiting_session",
  "running",
]);

export function isActiveRecurringRun(state: RecurringJobRunState): boolean {
  return ACTIVE_RECURRING_RUN_STATES.has(state);
}
