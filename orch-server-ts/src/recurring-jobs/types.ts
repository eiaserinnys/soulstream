export type RecurringJobRunTrigger = "scheduled" | "manual" | "event";
export type RecurringJobScheduleKind = "recurring" | "once" | "event";

export type RecurringJobEventTrigger = {
  readonly type: "node_connected";
  readonly nodeId: string;
  readonly settleSeconds: number;
  readonly cooldownSeconds: number;
  readonly repeat: boolean;
};

/** Boundary shape: every field except type is optional and filled by the server. */
export type RecurringJobEventTriggerInput = {
  readonly type?: unknown;
  readonly nodeId?: unknown;
  readonly settleSeconds?: unknown;
  readonly cooldownSeconds?: unknown;
  readonly repeat?: unknown;
};

export type RecurringNodePresence = {
  readonly nodeId: string;
  readonly episodeStartedAt: string;
  readonly lastSeenAt: string;
};

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
  readonly source: "browser" | "soul-app" | "agent" | "scheduler" | "external-llm";
  readonly isAdmin?: boolean;
};

export type RecurringJob = {
  readonly jobId: string;
  readonly ownerEmail: string;
  readonly executionCaller: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly prompt: string;
  readonly scheduleKind: RecurringJobScheduleKind;
  readonly scheduleExpressions: readonly string[];
  readonly runAt: string | null;
  /** Rows written before the event columns existed read as null. */
  readonly eventTrigger?: RecurringJobEventTrigger | null;
  readonly eventLastFiredAt?: string | null;
  readonly timezone: string;
  readonly nodeId: string;
  readonly agentId: string;
  /** null means use the selected agent's default at run dispatch time. */
  readonly modelPreset: string | null;
  readonly modelPresetFallbacks: readonly string[];
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
  readonly scheduleExpressions?: readonly string[];
  readonly runAt?: string;
  readonly eventTrigger?: RecurringJobEventTriggerInput;
  readonly nodeId: string;
  readonly agentId: string;
  readonly modelPreset: string | null;
  readonly modelPresetFallbacks?: readonly string[];
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
  readonly runAt?: string;
  readonly eventTrigger?: RecurringJobEventTriggerInput;
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly modelPreset?: string | null;
  readonly modelPresetFallbacks?: readonly string[];
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
  findJobOwnerEmail(jobId: string): Promise<string | null>;
  listAllJobs(includeArchived?: boolean): Promise<RecurringJob[]>;
  createJob(input: RecurringJob): Promise<RecurringJob>;
  findJobByCreateIdempotency(ownerEmail: string, idempotencyKey: string): Promise<RecurringJob | null>;
  updateJob(input: RecurringJob, expectedVersion: number): Promise<RecurringJob | RecurringJobConflict>;
  deleteOnceJob(jobId: string): Promise<boolean>;
  archiveJob(jobId: string, ownerEmail: string, expectedVersion: number, actorId: string, now: Date): Promise<RecurringJob | RecurringJobConflict | null>;
  listRuns(jobId: string, limit: number): Promise<RecurringJobRun[]>;
  findRunByManualIdempotency(jobId: string, idempotencyKey: string): Promise<RecurringJobRun | null>;
  findActiveRun(jobId: string): Promise<RecurringJobRun | null>;
  createManualRun(input: RecurringJobRun): Promise<RecurringRunCreation>;
  listDueJobs(now: Date, limit: number): Promise<RecurringJob[]>;
  /** Enabled, non-archived event jobs; they never appear in listDueJobs. */
  listEventJobs(limit: number): Promise<RecurringJob[]>;
  getNodePresence(nodeId: string): Promise<RecurringNodePresence | null>;
  upsertNodePresence(presence: RecurringNodePresence): Promise<RecurringNodePresence>;
  /**
   * One transaction: version CAS that stamps event_last_fired_at, then the
   * event run insert. Null means this tick lost the race and fired nothing.
   */
  reserveEventRun(input: {
    readonly job: RecurringJob;
    readonly run: RecurringJobRun;
    readonly now: Date;
  }): Promise<RecurringRunCreation | null>;
  listActiveRuns(limit: number): Promise<RecurringJobRun[]>;
  getJob(jobId: string): Promise<RecurringJob | null>;
  getRun(runId: string): Promise<RecurringJobRun | null>;
  getRunBySessionId(sessionId: string): Promise<RecurringJobRun | null>;
  /**
   * Persist a run transition only when it still has the expected state.  A
   * cancelled automatic run must not be revived by a stale scheduler tick.
   */
  updateRun(
    run: RecurringJobRun,
    expectedState?: RecurringJobRunState,
  ): Promise<RecurringJobRun | null>;
  /**
   * The sole transition that permits an outbound create_session command.
   * For scheduled work this atomically observes the current job state, so a
   * pause/archive which wins the race leaves the run unsent.
   */
  claimRunForDispatch(runId: string, now: Date): Promise<RecurringJobRun | null>;
  reserveScheduledRun(input: {
    readonly job: RecurringJob;
    /** A terminal record that compresses older missed scheduled occurrences. */
    readonly compressedRun?: RecurringJobRun;
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
  /** Registry connect instant; settle time is measured from this value. */
  readonly nodeConnectedAtMs?: (nodeId: string) => number | undefined;
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
