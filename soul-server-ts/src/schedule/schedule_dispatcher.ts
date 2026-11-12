import type { Logger } from "pino";
import { SESSION_MODEL_FALLBACK_REASON } from "@soulstream/wire-schema/model-preset-fallbacks";

import { PeriodicMaintenanceLoop } from "../runtime/periodic_maintenance_loop.js";
import type { CompletionNotifier } from "../task/completion_notifier.js";
import type { TaskManager } from "../task/task_manager.js";
import type { StartExecutionCallback } from "../task/task_intervention_route.js";
import { isActiveTaskStatus, type Task } from "../task/task_models.js";
import {
  CACHE_KEEPALIVE_PURPOSE,
  isCacheKeepaliveSchedule,
} from "../task/persistent_keepalive_marker.js";

import type { SoulstreamScheduleService } from "./schedule_service.js";
import type { SoulstreamSchedule } from "./schedule_models.js";

export interface ScheduleDispatcherConfig {
  nodeId: string;
  intervalMs?: number;
  batchSize?: number;
  claimTimeoutMs?: number;
  retryDelayMs?: number;
  orphanNodeTtlMs?: number;
  orphanStartupGraceMs?: number;
  startedAt?: Date;
}

/** One tick drains at most `batchSize` schedules, each bounded by its own awaits. */
const SCHEDULE_STEP_TIMEOUT_MS = 60_000;

/**
 * A failed wake is retried with a doubling delay before the reservation is
 * given up. One transient failure used to close the reservation as `failed`,
 * so a session that hit a limit never woke after it lifted.
 */
const MAX_DISPATCH_FAILURES = 5;
const DISPATCH_FAILURE_BASE_DELAY_MS = 30_000;
const DISPATCH_FAILURE_MAX_DELAY_MS = 300_000;

/**
 * 옛 orch가 돌려준 예약 줄에는 이 칸이 없다. 없거나 유한한 정수가 아니면 0으로
 * 본다. 그대로 더하면 NaN이 되어 미룸 시각이 Invalid Date가 되고, orch는
 * next_run_at을 NULL로 저장해 예약이 다시 잡히지 않는다.
 */
function consecutiveDispatchFailures(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function dispatchFailureDelayMs(failureCount: number): number {
  const exponent = Math.max(consecutiveDispatchFailures(failureCount) - 1, 0);
  return Math.min(
    DISPATCH_FAILURE_BASE_DELAY_MS * 2 ** exponent,
    DISPATCH_FAILURE_MAX_DELAY_MS,
  );
}

export class ScheduleDispatcher {
  private loop: PeriodicMaintenanceLoop | null = null;
  private readonly startedAt: Date;

  constructor(
    private readonly config: ScheduleDispatcherConfig,
    private readonly service: Pick<
      SoulstreamScheduleService,
      | "claimDueSchedules"
      | "touchNodeHeartbeat"
      | "repairExpiredClaims"
      | "markOrphanDueSchedules"
      | "restoreOrphanSchedulesForLiveNodes"
      | "consumeClaimedSchedule"
      | "confirmScheduleStillFiring"
      | "decideResumeDispatch"
      | "deferDispatch"
      | "finishDispatch"
      | "failDispatch"
    >,
    private readonly taskManager: Pick<
      TaskManager,
      "addIntervention" | "getTask" | "resolveScheduleResumeTask"
    >,
    private readonly onResume: StartExecutionCallback,
    private readonly logger: Logger,
    /**
     * The parent completion skipped by a model fallback is registered here
     * when the last wake attempt fails, so the caller is not left waiting.
     */
    private readonly completionNotifier?: Pick<CompletionNotifier, "notify">,
  ) {
    this.startedAt = config.startedAt ?? new Date();
  }

  /**
   * The node heartbeat is a separate lane step from schedule dispatch on
   * purpose: a wedged dispatch used to hold the tick guard forever, which
   * silently froze the heartbeat and made this node look dead to every other
   * node's recovery scan (260820 incident).
   */
  start(): void {
    if (this.loop) return;
    this.loop = new PeriodicMaintenanceLoop({
      lane: "schedule-dispatcher",
      steps: [
        {
          name: "touch_node_heartbeat",
          run: () => this.touchNodeHeartbeat(),
          // Bounded by the schedule host request deadline, and a skipped
          // heartbeat is what makes a live node look dead.
          reissueWhileOutstanding: true,
        },
        {
          name: "dispatch_due_schedules",
          run: () => this.dispatchDueSchedules(),
        },
      ],
      intervalMs: this.config.intervalMs ?? 30_000,
      stepTimeoutMs: SCHEDULE_STEP_TIMEOUT_MS,
      logger: this.logger,
    });
    void this.loop.start();
  }

  stop(): void {
    if (!this.loop) return;
    void this.loop.stop();
    this.loop = null;
  }

  /** Direct-drive entry point. Production drives the two steps as a lane. */
  async runOnce(now = new Date()): Promise<void> {
    await this.touchNodeHeartbeat();
    await this.dispatchDueSchedules(now);
  }

  private async touchNodeHeartbeat(): Promise<void> {
    try {
      await this.service.touchNodeHeartbeat(this.config.nodeId);
    } catch (err) {
      this.logger.warn({ err }, "schedule dispatcher heartbeat failed");
    }
  }

  private async dispatchDueSchedules(now = new Date()): Promise<void> {
    try {
      const batchSize = this.config.batchSize ?? 25;
      const staleAfterMs = this.config.orphanNodeTtlMs ?? 300_000;
      await this.service.repairExpiredClaims(now, batchSize);
      await this.service.restoreOrphanSchedulesForLiveNodes(staleAfterMs, batchSize);
      if (this.canMarkOrphans(now)) {
        await this.service.markOrphanDueSchedules(now, staleAfterMs, batchSize);
      }
      const claimed = await this.service.claimDueSchedules(
        this.config.nodeId,
        now,
        batchSize,
        this.config.claimTimeoutMs ?? 60_000,
      );
      for (const claim of claimed) {
        await this.dispatchClaim(claim.schedule, claim.claimToken, now);
      }
    } catch (err) {
      this.logger.warn({ err }, "schedule dispatcher tick failed");
    }
  }

  private canMarkOrphans(now: Date): boolean {
    const graceMs = this.config.orphanStartupGraceMs ?? 120_000;
    return now.getTime() - this.startedAt.getTime() >= graceMs;
  }

  private async dispatchClaim(
    claimedSchedule: SoulstreamSchedule,
    claimToken: string,
    now: Date,
  ): Promise<void> {
    const schedule = await this.service.consumeClaimedSchedule(
      claimedSchedule.scheduleId,
      claimToken,
    );
    if (!schedule) {
      this.logger.info(
        { scheduleId: claimedSchedule.scheduleId },
        "schedule claim skipped because store state changed",
      );
      return;
    }

    try {
      const ready = await this.service.confirmScheduleStillFiring(
        schedule.scheduleId,
        claimToken,
      );
      if (!ready) {
        this.logger.info(
          { scheduleId: schedule.scheduleId },
          "schedule firing skipped because store state changed",
        );
        return;
      }
      const cacheKeepalive = isCacheKeepaliveSchedule(ready);
      if (ready.sourceTool === "ResumeAfterLimit") {
        const localTask = this.taskManager.getTask(ready.sessionId);
        const decision = await this.service.decideResumeDispatch(
          ready,
          localTask !== undefined && isActiveTaskStatus(localTask.status),
        );
        if (decision.decision === "close") {
          this.logger.info({
            scheduleId: ready.scheduleId,
            reason: decision.reason,
          }, "resume-after-limit schedule skipped");
          await this.service.finishDispatch(ready, claimToken, now);
          return;
        }
        if (decision.decision === "defer") {
          await this.service.deferDispatch(
            ready,
            claimToken,
            new Date(now.getTime() + (this.config.retryDelayMs ?? 30_000)),
            decision.reason,
          );
          return;
        }
      }
      if (cacheKeepalive) {
        const task = this.taskManager.getTask(ready.sessionId);
        if (task && (isActiveTaskStatus(task.status) || task.interventionQueue.length > 0)) {
          await this.service.finishDispatch(ready, claimToken, now);
          return;
        }
      }
      const result = await this.taskManager.addIntervention(
        {
          agentSessionId: ready.sessionId,
          text: buildScheduledPrompt(ready),
          user: "Soulstream Scheduler",
          callerInfo: {
            source: "system",
            display_name: "Soulstream Scheduler",
            user_id: "soulstream-scheduler",
          },
          ...(cacheKeepalive
            ? { purpose: CACHE_KEEPALIVE_PURPOSE }
            : {}),
          queueIfRunning: false,
        },
        this.onResume,
      );
      if ("deferred" in result) {
        if (cacheKeepalive) {
          await this.service.finishDispatch(ready, claimToken, now);
          return;
        }
        await this.service.deferDispatch(
          ready,
          claimToken,
          new Date(now.getTime() + (this.config.retryDelayMs ?? 30_000)),
          "session is running and cannot accept durable scheduled intervention yet",
        );
        return;
      }
      await this.service.finishDispatch(ready, claimToken, now);
    } catch (err) {
      await this.handleDispatchFailure(schedule, claimToken, now, err);
    }
  }

  /**
   * Back off while the wake keeps failing; only the last attempt closes the
   * reservation, and only then is the completion a fallback skipped delivered
   * through the node's normal completion registration path.
   */
  private async handleDispatchFailure(
    schedule: SoulstreamSchedule,
    claimToken: string,
    now: Date,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const failures = consecutiveDispatchFailures(schedule.dispatchFailureCount) + 1;
    this.logger.warn(
      { err, sessionId: schedule.sessionId, scheduleId: schedule.scheduleId, failures },
      "scheduled intervention failed",
    );
    if (failures >= MAX_DISPATCH_FAILURES) {
      await this.notifySkippedCompletion(schedule);
      await this.service.failDispatch(schedule, claimToken, message);
      return;
    }
    await this.service.deferDispatch(
      schedule,
      claimToken,
      new Date(now.getTime() + dispatchFailureDelayMs(failures)),
      message,
      true,
    );
  }

  /**
   * Only the model fallback path skips the parent completion before reserving
   * the wake; the persistent-session limit path registers it first. The
   * distinguishing fact is the fallback pending marker, which is persisted in
   * the session metadata, so it still holds after a node restart. A memory
   * flag would not: a resumed node would either double-notify or drop it.
   */
  private async notifySkippedCompletion(schedule: SoulstreamSchedule): Promise<void> {
    if (schedule.sourceTool !== "ResumeAfterLimit") return;
    const task = await this.resolveSkippedCompletionTask(schedule);
    if (!task) return;
    if (task.persistentGeneration?.pending?.reason !== SESSION_MODEL_FALLBACK_REASON) return;
    try {
      await this.completionNotifier?.notify(task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: schedule.sessionId, scheduleId: schedule.scheduleId },
        "skipped parent completion registration failed",
      );
    }
  }

  private async resolveSkippedCompletionTask(
    schedule: SoulstreamSchedule,
  ): Promise<Task | null> {
    const cached = this.taskManager.getTask(schedule.sessionId);
    if (cached) return cached;
    try {
      const loaded = await this.taskManager.resolveScheduleResumeTask(schedule.sessionId);
      if (!loaded) {
        this.logger.warn(
          { sessionId: schedule.sessionId, scheduleId: schedule.scheduleId },
          "skipped parent completion not registered: local task is unavailable",
        );
      }
      return loaded;
    } catch (err) {
      this.logger.warn(
        { err, sessionId: schedule.sessionId, scheduleId: schedule.scheduleId },
        "skipped parent completion not registered: local task load failed",
      );
      return null;
    }
  }
}

function buildScheduledPrompt(schedule: SoulstreamSchedule): string {
  if (isCacheKeepaliveSchedule(schedule)) return schedule.prompt;
  const header = schedule.kind === "wakeup"
    ? "Scheduled wakeup"
    : `Scheduled cron${schedule.cronExpression ? ` (${schedule.cronExpression})` : ""}`;
  return `[${header}]\n\n${schedule.prompt}`;
}
