import { randomUUID } from "node:crypto";

import {
  compileRecurringSchedule,
  latestRecurringOccurrenceOnOrBefore,
  nextRecurringOccurrences,
} from "./cron.js";
import {
  assertRecurringJobActor,
  compileSchedule,
  normalizedContainer,
  normalizedModelPreset,
  onceTimezone,
  parseRunAt,
  positiveLateRunWindowSeconds,
  requiredText,
  validation,
  versionConflict,
} from "./input_validation.js";
import {
  mergeRecurringJobUpdate,
  normalizeRecurringJobCreate,
  type ValidateRecurringJobTarget,
} from "./service_normalization.js";
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
import {
  isConfirmedNodeReject,
  isUnavailableTarget,
  isUncertainLaunchFailure,
  schedulerActorFor,
} from "./dispatch_guards.js";
import { jobForRun } from "./run_snapshot.js";
import { makeRecurringRun, saveRecurringRun } from "./run_lifecycle.js";

export type RecurringJobServiceOptions = {
  readonly repository: RecurringJobRepository;
  readonly launcher?: RecurringSessionLauncher;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Shared UI/MCP target and folder-access gate. */
  readonly validateTarget?: ValidateRecurringJobTarget;
};

export class RecurringJobService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: RecurringJobServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  async list(actor: RecurringJobActor, includeArchived = false): Promise<RecurringJob[]> {
    assertRecurringJobActor(actor);
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
    assertRecurringJobActor(actor);
    const idempotencyKey = requiredText(raw.idempotencyKey, "idempotency key");
    const existing = await this.options.repository.findJobByCreateIdempotency(
      actor.ownerEmail,
      idempotencyKey,
    );
    if (existing) return existing;
    const normalized = await normalizeRecurringJobCreate(actor, raw, this.now, this.options.validateTarget);
    const { schedule: _schedule, ...jobFields } = normalized;
    const now = this.now();
    const enabled = raw.enabled ?? true;
    const firstRun = normalized.schedule
      ? nextRecurringOccurrences(normalized.schedule, now, 1)[0]
      : null;
    if (normalized.schedule && !firstRun) {
      throw new Error("compiled schedule did not produce a future occurrence");
    }
    const job: RecurringJob = {
      jobId: this.newId(),
      ownerEmail: actor.ownerEmail,
      executionCaller: { ...actor.callerInfo },
      ...jobFields,
      nextRunAt: enabled ? normalized.runAt ?? firstRun?.toISOString() ?? null : null,
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
      ...await this.mergeUpdate(actor, current, input, now),
      updatedBy: actor.actorId,
    };
    const updated = await this.options.repository.updateJob(candidate, input.expectedVersion);
    if ("code" in updated) throw versionConflict(updated.job);
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
    assertRecurringJobActor(actor);
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
    if ("code" in archived) throw versionConflict(archived.job);
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
    const run = makeRecurringRun(job, {
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
    }, this.newId);
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
    const schedule = job.scheduleKind === "once" ? null : compileRecurringSchedule(job);
    const nextRunAt = schedule ? nextRecurringOccurrences(schedule, now, 1)[0] ?? null : null;
    const latestOccurrence = schedule
      ? latestRecurringOccurrenceOnOrBefore(schedule, now)
      : scheduledFor;
    const latestEligible = latestOccurrence !== null &&
      latestOccurrence.getTime() >= scheduledFor.getTime() &&
      now.getTime() - latestOccurrence.getTime() <= job.lateRunWindowSeconds * 1_000
      ? latestOccurrence
      : null;
    const selectedScheduledFor = latestEligible ?? scheduledFor;
    const compressedRun = latestEligible && latestEligible.getTime() > scheduledFor.getTime()
      ? makeRecurringRun(job, {
        trigger: "scheduled",
        scheduledFor,
        state: "skipped_late",
        now,
        reason: {
          code: "LATE_RUN_WINDOW_EXPIRED",
          message: `Older missed occurrences beginning at ${scheduledFor.toISOString()} were compressed; ${latestEligible.toISOString()} is the latest eligible occurrence.`,
        },
      }, this.newId)
      : undefined;
    const late = latestEligible === null;
    const active = await this.options.repository.findActiveRun(job.jobId);
    const waiting = !this.options.launcher?.isNodeConnected(job.nodeId);
    const run = makeRecurringRun(job, {
      trigger: "scheduled",
      scheduledFor: selectedScheduledFor,
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
    }, this.newId);
    const reserved = await this.options.repository.reserveScheduledRun({
      job,
      compressedRun,
      run,
      nextRunAt,
      now,
    });
    if (!reserved || reserved.run.state !== "queued") return reserved?.run ?? null;
    return await this.dispatchRun(job, reserved.run);
  }

  /** Sends only the fixed run session ID; awaiting results are rechecked by that same ID. */
  async dispatchRun(job: RecurringJob, run: RecurringJobRun): Promise<RecurringJobRun> {
    const launcher = this.options.launcher;
    if (!launcher || !isActiveRecurringRun(run.state)) return run;
    const now = this.now();
    let frozenJob: RecurringJob;
    try {
      frozenJob = jobForRun(job, run);
    } catch (error) {
      return await saveRecurringRun(this.options.repository, run, "error", now, {
        code: "RUN_SNAPSHOT_INVALID",
        message: error instanceof Error ? error.message : "Recurring run snapshot is invalid.",
      });
    }
    if (run.trigger === "scheduled" && run.scheduledFor) {
      const expiresAt = Date.parse(run.scheduledFor) + frozenJob.lateRunWindowSeconds * 1_000;
      if (now.getTime() > expiresAt) {
        return await saveRecurringRun(this.options.repository, run, "skipped_late", now, {
          code: "LATE_RUN_WINDOW_EXPIRED",
          message: "The node reconnected after this occurrence lost its execution eligibility.",
        });
      }
    }
    if (!launcher.isNodeConnected(frozenJob.nodeId)) {
      return await saveRecurringRun(this.options.repository, run, "waiting_for_node", now, {
        code: "NODE_OFFLINE",
        message: `Node ${frozenJob.nodeId} is offline. No create_session command has been sent.`,
      });
    }
    try {
      await this.options.validateTarget?.({
        actor: schedulerActorFor(frozenJob),
        target: frozenJob,
        requireAvailableTarget: true,
      });
    } catch (error) {
      if (isUnavailableTarget(error)) {
        return await saveRecurringRun(this.options.repository, run, "waiting_for_node", now, {
          code: "NODE_OFFLINE",
          message: `Node ${frozenJob.nodeId} became unavailable before create_session was sent.`,
        });
      }
      return await saveRecurringRun(this.options.repository, run, "error", now, {
        code: "TARGET_INVALID_AT_DISPATCH",
        message: error instanceof Error ? error.message : "Recurring run target is no longer valid.",
      });
    }
    // This is the final DB-backed pause/archive gate. A manual run remains
    // eligible while paused, but no queued run survives archive.
    const dispatching = await this.options.repository.claimRunForDispatch(run.runId, now);
    if (!dispatching) {
      const currentRun = await this.options.repository.getRun(run.runId);
      const currentJob = await this.options.repository.getJob(run.jobId);
      if (currentRun && currentJob && currentJob.archivedAt !== null &&
        (currentRun.state === "queued" || currentRun.state === "waiting_for_node")) {
        return await saveRecurringRun(this.options.repository, currentRun, "cancelled", now, {
          code: "JOB_ARCHIVED",
          message: "This run was cancelled before node dispatch because its job was archived.",
        });
      }
      if (run.trigger === "scheduled" && currentRun && currentJob && !currentJob.enabled &&
        (currentRun.state === "queued" || currentRun.state === "waiting_for_node")) {
        return await saveRecurringRun(this.options.repository, currentRun, "cancelled", now, {
          code: "JOB_PAUSED",
          message: "This automatic run was cancelled before node dispatch.",
        });
      }
      return currentRun ?? run;
    }
    let shouldDeleteOnceJob = false;
    let saved: RecurringJobRun;
    try {
      const launched = await launcher.createRecurringSession({ job: frozenJob, run: dispatching });
      const launchedRun = {
        ...dispatching,
        jobSnapshot: {
          ...dispatching.jobSnapshot,
          resolvedModelPreset: launched.resolvedModelPreset,
        },
      };
      saved = await saveRecurringRun(this.options.repository, launchedRun, launched.state, this.now(), launched.state === "awaiting_session" ? {
        code: "AWAITING_SESSION_CONFIRMATION",
        message: "The create_session request may have reached the node. Soulstream will only recheck this fixed session ID.",
      } : null);
      shouldDeleteOnceJob = job.scheduleKind === "once" && launched.state === "running";
    } catch (error) {
      if (isUncertainLaunchFailure(error)) {
        return await saveRecurringRun(this.options.repository, dispatching, "awaiting_session", this.now(), {
          code: "AWAITING_SESSION_CONFIRMATION",
          message: "The create_session request may have reached the node. Soulstream will only recheck this fixed session ID.",
        });
      }
      return await saveRecurringRun(this.options.repository, dispatching, "error", this.now(), {
        code: isConfirmedNodeReject(error) ? "CREATE_SESSION_REJECTED" : "CREATE_SESSION_BEFORE_SEND_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (shouldDeleteOnceJob) await this.options.repository.deleteOnceJob(job.jobId);
    return saved;
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
        return await saveRecurringRun(this.options.repository, run, "awaiting_session", now, {
          code: "AWAITING_SESSION_CONFIRMATION",
          message: "No durable session row is visible yet. A new session will not be created automatically.",
        });
      }
      if (run.state === "dispatching") {
        return await saveRecurringRun(this.options.repository, run, "dispatching", now, {
          code: "CREATE_SESSION_DISPATCH_UNRESOLVED",
          message: "The scheduler stopped before create_session acknowledgement. This fixed session ID will not be recreated automatically; open or restore it manually if it appears.",
        });
      }
      return await saveRecurringRun(this.options.repository, run, "error", now, {
        code: "SESSION_DELETED",
        message: "The previously observed session was deleted. Open or restore that existing session manually; no replacement was created.",
      });
    }
    const saved = session.status === "completed" || session.status === "error" || session.status === "interrupted"
      ? await saveRecurringRun(this.options.repository, run, session.status, now, null)
      : await saveRecurringRun(this.options.repository, run, "running", now, null);
    const job = await this.options.repository.getJob(run.jobId);
    if (job?.scheduleKind === "once") await this.options.repository.deleteOnceJob(job.jobId);
    return saved;
  }

  private async mergeUpdate(
    actor: RecurringJobActor,
    current: RecurringJob,
    input: RecurringJobUpdateInput,
    now: Date,
  ): Promise<RecurringJob> {
    if (current.scheduleKind === "once") {
      if (input.scheduleExpressions !== undefined) {
        throw validation("schedule_expressions cannot be changed for a once job");
      }
      const enabled = input.enabled ?? current.enabled;
      const runAt = input.runAt === undefined ? current.runAt! : requiredText(input.runAt, "run_at");
      const runAtDate = parseRunAt(runAt);
      const recomputeNextRun = input.runAt !== undefined || (input.enabled === true && !current.enabled);
      let nextRunAt = current.nextRunAt;
      if (!enabled) nextRunAt = null;
      else if (recomputeNextRun) {
        if (runAtDate.getTime() <= now.getTime()) throw validation("run_at must be in the future");
        nextRunAt = runAt;
      }
      const candidate = {
        ...current,
        name: input.name === undefined ? current.name : requiredText(input.name, "name"),
        prompt: input.prompt === undefined ? current.prompt : requiredText(input.prompt, "prompt"),
        timezone: input.timezone === undefined ? current.timezone : onceTimezone(input.timezone),
        scheduleKind: "once" as const,
        scheduleExpressions: [],
        runAt,
        nodeId: input.nodeId === undefined ? current.nodeId : requiredText(input.nodeId, "node_id"),
        agentId: input.agentId === undefined ? current.agentId : requiredText(input.agentId, "agent_id"),
        modelPreset: input.modelPreset === undefined
          ? current.modelPreset
          : normalizedModelPreset(input.modelPreset),
        container: input.container === undefined ? current.container : normalizedContainer(input.container),
        folderId: input.folderId === undefined ? current.folderId : requiredText(input.folderId, "folder_id"),
        lateRunWindowSeconds: positiveLateRunWindowSeconds(
          input.lateRunWindowSeconds === undefined ? current.lateRunWindowSeconds : input.lateRunWindowSeconds,
        ),
        enabled,
        nextRunAt,
        updatedAt: now.toISOString(),
      } satisfies RecurringJob;
      await this.options.validateTarget?.({
        actor,
        target: candidate,
        requireAvailableTarget: candidate.nodeId !== current.nodeId ||
          candidate.agentId !== current.agentId ||
          candidate.modelPreset !== current.modelPreset,
      });
      return candidate;
    }
    return await mergeRecurringJobUpdate(actor, current, input, now, this.options.validateTarget);
  }

  private async requireJob(
    actor: RecurringJobActor,
    jobId: string,
    includeArchived = false,
  ): Promise<RecurringJob> {
    assertRecurringJobActor(actor);
    const job = await this.options.repository.findJobForOwner(jobId, actor.ownerEmail, includeArchived);
    if (!job) throw new RecurringJobError("NOT_FOUND", "Recurring job was not found", 404);
    if (!includeArchived && job.archivedAt !== null) {
      throw new RecurringJobError("ARCHIVED", "Recurring job is archived", 409, job);
    }
    return job;
  }
}

function positiveVersion(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function boundedLimit(value: number): number { return Number.isSafeInteger(value) ? Math.max(1, Math.min(value, 100)) : 50; }
