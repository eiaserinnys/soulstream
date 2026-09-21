import { randomUUID } from "node:crypto";

import {
  compileRecurringSchedule,
  nextRecurringOccurrences,
} from "./cron.js";
import {
  isActiveRecurringRun,
  RecurringJobError,
  type RecurringJob,
  type RecurringJobActor,
  type RecurringJobCreateInput,
  type RecurringJobRepository,
  type RecurringJobRun,
  type RecurringJobUpdateInput,
  type RecurringSessionLauncher,
} from "./types.js";

export type RecurringJobServiceOptions = {
  readonly repository: RecurringJobRepository;
  readonly launcher?: RecurringSessionLauncher;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly validateTarget?: (input: {
    readonly nodeId: string;
    readonly agentId: string;
    readonly modelPreset: string | null;
    readonly container: RecurringJob["container"];
    readonly folderId: string;
  }) => Promise<void>;
};

export class RecurringJobService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: RecurringJobServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  async list(actor: RecurringJobActor, includeArchived = false): Promise<RecurringJob[]> {
    assertActor(actor);
    return await this.options.repository.listJobsForOwner(actor.ownerEmail, includeArchived);
  }

  async get(actor: RecurringJobActor, jobId: string, includeArchived = false): Promise<RecurringJob> {
    return await this.requireJob(actor, jobId, includeArchived);
  }

  preview(input: { timezone: string; scheduleExpressions: readonly string[]; now?: Date }): {
    timezone: string;
    scheduleExpressions: readonly string[];
    nextRuns: string[];
  } {
    const schedule = compileSchedule(input);
    const now = input.now ?? this.now();
    return {
      timezone: schedule.timezone,
      scheduleExpressions: schedule.scheduleExpressions,
      nextRuns: nextRecurringOccurrences(schedule, now, 5).map((value) => value.toISOString()),
    };
  }

  async create(actor: RecurringJobActor, raw: RecurringJobCreateInput): Promise<RecurringJob> {
    assertActor(actor);
    const idempotencyKey = requiredText(raw.idempotencyKey, "idempotency key");
    const existing = await this.options.repository.findJobByCreateIdempotency(
      actor.ownerEmail,
      idempotencyKey,
    );
    if (existing) return existing;
    const normalized = await this.normalizeCreateOrUpdate(raw);
    const { schedule: _schedule, ...jobFields } = normalized;
    const now = this.now();
    const firstRun = nextRecurringOccurrences(normalized.schedule, now, 1)[0];
    if (!firstRun) throw new Error("compiled schedule did not produce a future occurrence");
    const enabled = raw.enabled ?? true;
    const job: RecurringJob = {
      jobId: this.newId(),
      ownerEmail: actor.ownerEmail,
      executionCaller: { ...actor.callerInfo },
      ...jobFields,
      nextRunAt: enabled ? firstRun.toISOString() : null,
      enabled,
      archivedAt: null,
      version: 1,
      createdIdempotencyKey: idempotencyKey,
      createdBy: actor.actorId,
      updatedBy: actor.actorId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    try {
      return await this.options.repository.createJob(job);
    } catch (error) {
      const raced = await this.options.repository.findJobByCreateIdempotency(
        actor.ownerEmail,
        idempotencyKey,
      );
      if (raced) return raced;
      throw error;
    }
  }

  async update(
    actor: RecurringJobActor,
    jobId: string,
    input: RecurringJobUpdateInput,
  ): Promise<RecurringJob> {
    const current = await this.requireJob(actor, jobId);
    if (!positiveVersion(input.expectedVersion)) throw validation("expected_version is required");
    const now = this.now();
    const candidate = {
      ...await this.mergeUpdate(current, input, now),
      updatedBy: actor.actorId,
    };
    const updated = await this.options.repository.updateJob(candidate, input.expectedVersion);
    if ("code" in updated) throw conflict(updated.job);
    if (!updated.enabled) {
      await this.options.repository.cancelAutomaticPendingRuns(updated.jobId, {
        code: "JOB_PAUSED",
        message: "The recurring job was paused before this automatic run was sent.",
      }, now);
    }
    return updated;
  }

  async archive(
    actor: RecurringJobActor,
    jobId: string,
    expectedVersion: number,
  ): Promise<RecurringJob> {
    assertActor(actor);
    if (!positiveVersion(expectedVersion)) throw validation("expected_version is required");
    const now = this.now();
    const archived = await this.options.repository.archiveJob(
      jobId,
      actor.ownerEmail,
      expectedVersion,
      actor.actorId,
      now,
    );
    if (!archived) throw new RecurringJobError("NOT_FOUND", "Recurring job was not found", 404);
    if ("code" in archived) throw conflict(archived.job);
    return archived;
  }

  async listRuns(actor: RecurringJobActor, jobId: string, limit = 50): Promise<RecurringJobRun[]> {
    await this.requireJob(actor, jobId, true);
    return await this.options.repository.listRuns(jobId, boundedLimit(limit));
  }

  async runManual(
    actor: RecurringJobActor,
    jobId: string,
    idempotencyKey: string,
  ): Promise<RecurringJobRun> {
    const job = await this.requireJob(actor, jobId);
    const key = requiredText(idempotencyKey, "idempotency key");
    const repeated = await this.options.repository.findRunByManualIdempotency(jobId, key);
    if (repeated) return repeated;
    const active = await this.options.repository.findActiveRun(jobId);
    const now = this.now();
    const run = this.makeRun(job, {
      trigger: "manual",
      manualIdempotencyKey: key,
      state: active ? "skipped_overlap" : "queued",
      now,
      ...(active ? {
        reason: {
          code: "OVERLAP_ACTIVE_RUN",
          message: `Existing run ${active.runId} is still ${active.state}; no second session was created.`,
        },
      } : {}),
    });
    const created = await this.options.repository.createManualRun(run);
    if (!created.created || created.run.state !== "queued") return created.run;
    return await this.dispatchRun(job, created.run);
  }

  /** Called by the central scheduler for one due job. */
  async reserveAndDispatchDueJob(job: RecurringJob): Promise<RecurringJobRun | null> {
    if (!job.enabled || job.archivedAt !== null || !job.nextRunAt) return null;
    const now = this.now();
    const scheduledFor = new Date(job.nextRunAt);
    if (!Number.isFinite(scheduledFor.getTime())) throw new Error(`invalid next_run_at: ${job.jobId}`);
    const schedule = compileRecurringSchedule(job);
    const nextRunAt = nextRecurringOccurrences(schedule, now, 1)[0] ?? null;
    const late = now.getTime() - scheduledFor.getTime() > job.lateRunWindowSeconds * 1_000;
    const active = await this.options.repository.findActiveRun(job.jobId);
    const waiting = !this.options.launcher?.isNodeConnected(job.nodeId);
    const run = this.makeRun(job, {
      trigger: "scheduled",
      scheduledFor,
      state: late ? "skipped_late" : active ? "skipped_overlap" : waiting ? "waiting_for_node" : "queued",
      now,
      ...(late ? {
        reason: {
          code: "LATE_RUN_WINDOW_EXPIRED",
          message: `The ${scheduledFor.toISOString()} occurrence exceeded the ${job.lateRunWindowSeconds}s eligibility window.`,
        },
      } : active ? {
        reason: {
          code: "OVERLAP_ACTIVE_RUN",
          message: `Existing run ${active.runId} is still ${active.state}; the scheduled occurrence was not sent.`,
        },
      } : waiting ? {
        reason: {
          code: "NODE_OFFLINE",
          message: `Node ${job.nodeId} is offline; this occurrence remains eligible until its late-run window expires.`,
        },
      } : {}),
    });
    const reserved = await this.options.repository.reserveScheduledRun({
      job,
      run,
      nextRunAt,
      now,
    });
    if (!reserved || reserved.run.state !== "queued") return reserved?.run ?? null;
    return await this.dispatchRun(job, reserved.run);
  }

  /**
   * Sends only the fixed run session ID. A thrown launch is a pre-send failure;
   * an awaiting result means a command may have been accepted and must only be
   * reconciled by the same ID.
   */
  async dispatchRun(job: RecurringJob, run: RecurringJobRun): Promise<RecurringJobRun> {
    const launcher = this.options.launcher;
    if (!launcher || !isActiveRecurringRun(run.state)) return run;
    const currentJob = await this.options.repository.getJob(job.jobId) ?? job;
    const now = this.now();
    if (run.trigger === "scheduled" && (!currentJob.enabled || currentJob.archivedAt !== null)) {
      return await this.saveRun(run, "cancelled", now, {
        code: currentJob.archivedAt ? "JOB_ARCHIVED" : "JOB_PAUSED",
        message: "This automatic run was cancelled before node dispatch.",
      });
    }
    if (run.trigger === "scheduled" && run.scheduledFor) {
      const expiresAt = Date.parse(run.scheduledFor) + currentJob.lateRunWindowSeconds * 1_000;
      if (now.getTime() > expiresAt) {
        return await this.saveRun(run, "skipped_late", now, {
          code: "LATE_RUN_WINDOW_EXPIRED",
          message: "The node reconnected after this occurrence lost its execution eligibility.",
        });
      }
    }
    if (!launcher.isNodeConnected(currentJob.nodeId)) {
      return await this.saveRun(run, "waiting_for_node", now, {
        code: "NODE_OFFLINE",
        message: `Node ${currentJob.nodeId} is offline. No create_session command has been sent.`,
      });
    }
    const dispatching = await this.saveRun(run, "dispatching", now, null);
    try {
      const launched = await launcher.createRecurringSession({ job: currentJob, run: dispatching });
      const launchedRun = {
        ...dispatching,
        jobSnapshot: {
          ...dispatching.jobSnapshot,
          resolvedModelPreset: launched.resolvedModelPreset,
        },
      };
      return await this.saveRun(launchedRun, launched.state, this.now(), launched.state === "awaiting_session" ? {
        code: "AWAITING_SESSION_CONFIRMATION",
        message: "The create_session request may have reached the node. Soulstream will only recheck this fixed session ID.",
      } : null);
    } catch (error) {
      const afterSend = typeof error === "object" && error !== null &&
        "dispatchPhase" in error && (error as { dispatchPhase?: unknown }).dispatchPhase === "after_send";
      return await this.saveRun(dispatching, "error", this.now(), {
        code: afterSend ? "CREATE_SESSION_REJECTED" : "CREATE_SESSION_BEFORE_SEND_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async reconcileSession(sessionId: string): Promise<RecurringJobRun | null> {
    const launcher = this.options.launcher;
    if (!launcher) return null;
    const run = await this.options.repository.getRunBySessionId(sessionId);
    if (!run || !isActiveRecurringRun(run.state)) return run;
    const session = await launcher.findDurableSession(sessionId);
    const now = this.now();
    if (!session) {
      if (run.state === "awaiting_session") {
        return await this.saveRun(run, "awaiting_session", now, {
          code: "AWAITING_SESSION_CONFIRMATION",
          message: "No durable session row is visible yet. A new session will not be created automatically.",
        });
      }
      if (run.state === "dispatching") {
        return await this.saveRun(run, "dispatching", now, {
          code: "CREATE_SESSION_DISPATCH_UNRESOLVED",
          message: "The scheduler stopped before create_session acknowledgement. This fixed session ID will not be recreated automatically; open or restore it manually if it appears.",
        });
      }
      return await this.saveRun(run, "error", now, {
        code: "SESSION_DELETED",
        message: "The previously observed session was deleted. Open or restore that existing session manually; no replacement was created.",
      });
    }
    if (session.status === "completed" || session.status === "error" || session.status === "interrupted") {
      return await this.saveRun(run, session.status, now, null);
    }
    return await this.saveRun(run, "running", now, null);
  }

  private async mergeUpdate(
    current: RecurringJob,
    input: RecurringJobUpdateInput,
    now: Date,
  ): Promise<RecurringJob> {
    const scheduleExpressions = input.scheduleExpressions ?? current.scheduleExpressions;
    const timezone = input.timezone ?? current.timezone;
    const schedule = compileSchedule({ timezone, scheduleExpressions });
    const enabled = input.enabled ?? current.enabled;
    const modelPreset = input.modelPreset === undefined
      ? current.modelPreset
      : normalizedModelPreset(input.modelPreset);
    const recomputeNextRun =
      (input.enabled === true && !current.enabled) ||
      input.timezone !== undefined ||
      input.scheduleExpressions !== undefined;
    const nextOccurrence = nextRecurringOccurrences(schedule, now, 1)[0];
    if (!nextOccurrence) throw new Error("compiled schedule did not produce a future occurrence");
    const nextRunAt = !enabled
      ? null
      : recomputeNextRun
        ? nextOccurrence.toISOString()
        : current.nextRunAt;
    const candidate = {
      ...current,
      name: input.name === undefined ? current.name : requiredText(input.name, "name"),
      prompt: input.prompt === undefined ? current.prompt : requiredText(input.prompt, "prompt"),
      scheduleExpressions: schedule.scheduleExpressions,
      timezone: schedule.timezone,
      nodeId: input.nodeId === undefined ? current.nodeId : requiredText(input.nodeId, "node_id"),
      agentId: input.agentId === undefined ? current.agentId : requiredText(input.agentId, "agent_id"),
      modelPreset,
      container: input.container === undefined ? current.container : normalizedContainer(input.container),
      folderId: input.folderId === undefined ? current.folderId : requiredText(input.folderId, "folder_id"),
      enabled,
      nextRunAt,
      updatedAt: now.toISOString(),
    } satisfies RecurringJob;
    await this.options.validateTarget?.(candidate);
    return candidate;
  }

  private async normalizeCreateOrUpdate(input: RecurringJobCreateInput): Promise<{
    name: string;
    prompt: string;
    scheduleExpressions: readonly string[];
    timezone: string;
    nodeId: string;
    agentId: string;
    modelPreset: string | null;
    container: RecurringJob["container"];
    folderId: string;
    lateRunWindowSeconds: number;
    schedule: ReturnType<typeof compileRecurringSchedule>;
  }> {
    const schedule = compileSchedule(input);
    const normalized = {
      name: requiredText(input.name, "name"),
      prompt: requiredText(input.prompt, "prompt"),
      scheduleExpressions: schedule.scheduleExpressions,
      timezone: schedule.timezone,
      nodeId: requiredText(input.nodeId, "node_id"),
      agentId: requiredText(input.agentId, "agent_id"),
      modelPreset: normalizedModelPreset(input.modelPreset),
      container: normalizedContainer(input.container),
      folderId: requiredText(input.folderId, "folder_id"),
      lateRunWindowSeconds: input.lateRunWindowSeconds ?? 1_800,
      schedule,
    };
    if (!Number.isSafeInteger(normalized.lateRunWindowSeconds) || normalized.lateRunWindowSeconds < 1) {
      throw validation("late_run_window_seconds must be a positive integer");
    }
    await this.options.validateTarget?.(normalized);
    return normalized;
  }

  private makeRun(
    job: RecurringJob,
    input: {
      trigger: RecurringJobRun["trigger"];
      scheduledFor?: Date;
      manualIdempotencyKey?: string;
      state: RecurringJobRun["state"];
      now: Date;
      reason?: { code: string; message: string };
    },
  ): RecurringJobRun {
    const terminal = !isActiveRecurringRun(input.state);
    return {
      runId: this.newId(), jobId: job.jobId, trigger: input.trigger,
      scheduledFor: input.scheduledFor?.toISOString() ?? null,
      manualIdempotencyKey: input.manualIdempotencyKey ?? null,
      sessionId: this.newId(),
      jobSnapshot: {
        name: job.name, prompt: job.prompt, timezone: job.timezone,
        scheduleExpressions: job.scheduleExpressions, nodeId: job.nodeId, agentId: job.agentId,
        modelPreset: job.modelPreset, container: job.container, folderId: job.folderId,
        executionCaller: job.executionCaller,
      },
      state: input.state,
      reasonCode: input.reason?.code ?? null, reasonMessage: input.reason?.message ?? null,
      createdAt: input.now.toISOString(),
      startedAt: null,
      finishedAt: terminal ? input.now.toISOString() : null,
      updatedAt: input.now.toISOString(),
    };
  }

  private async saveRun(
    run: RecurringJobRun,
    state: RecurringJobRun["state"],
    now: Date,
    reason: { code: string; message: string } | null,
  ): Promise<RecurringJobRun> {
    const terminal = !isActiveRecurringRun(state);
    return await this.options.repository.updateRun({
      ...run,
      state,
      reasonCode: reason?.code ?? null,
      reasonMessage: reason?.message ?? null,
      startedAt: state === "running" && !run.startedAt ? now.toISOString() : run.startedAt,
      finishedAt: terminal ? now.toISOString() : null,
      updatedAt: now.toISOString(),
    });
  }

  private async requireJob(
    actor: RecurringJobActor,
    jobId: string,
    includeArchived = false,
  ): Promise<RecurringJob> {
    assertActor(actor);
    const job = await this.options.repository.findJobForOwner(jobId, actor.ownerEmail, includeArchived);
    if (!job) throw new RecurringJobError("NOT_FOUND", "Recurring job was not found", 404);
    if (!includeArchived && job.archivedAt !== null) {
      throw new RecurringJobError("ARCHIVED", "Recurring job is archived", 409, job);
    }
    return job;
  }
}

function assertActor(actor: RecurringJobActor): void {
  if (!actor || !actor.ownerEmail.trim() || !actor.actorId.trim()) {
    throw new RecurringJobError("FORBIDDEN", "A verified recurring-job actor is required", 403);
  }
}
function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw validation(`${label} is required`);
  return value.trim();
}
function normalizedModelPreset(value: string | null): string | null {
  if (value === null) return null;
  return requiredText(value, "model_preset");
}
function normalizedContainer(value: RecurringJob["container"]): RecurringJob["container"] {
  if (!value || (value.kind !== "folder" && value.kind !== "task")) throw validation("container.kind is invalid");
  return { kind: value.kind, id: requiredText(value.id, "container.id") };
}
function positiveVersion(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function boundedLimit(value: number): number { return Number.isSafeInteger(value) ? Math.max(1, Math.min(value, 100)) : 50; }
function validation(message: string): RecurringJobError { return new RecurringJobError("VALIDATION", message, 422); }
function compileSchedule(input: { timezone: string; scheduleExpressions: readonly string[] }): ReturnType<typeof compileRecurringSchedule> {
  try {
    return compileRecurringSchedule(input);
  } catch (error) {
    throw validation(error instanceof Error ? error.message : "invalid recurring schedule");
  }
}
function conflict(job: RecurringJob): RecurringJobError {
  return new RecurringJobError("VERSION_CONFLICT", "Recurring job changed. Reload before saving.", 409, job);
}
