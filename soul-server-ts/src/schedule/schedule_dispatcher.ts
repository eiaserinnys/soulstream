import type { Logger } from "pino";

import { PeriodicMaintenanceLoop } from "../runtime/periodic_maintenance_loop.js";
import type { TaskManager } from "../task/task_manager.js";
import type { StartExecutionCallback } from "../task/task_intervention_route.js";

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
      | "deferDispatch"
      | "finishDispatch"
      | "failDispatch"
    >,
    private readonly taskManager: Pick<TaskManager, "addIntervention">,
    private readonly onResume: StartExecutionCallback,
    private readonly logger: Logger,
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
          queueIfRunning: false,
        },
        this.onResume,
      );
      if ("deferred" in result) {
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
      const message = err instanceof Error ? err.message : String(err);
      await this.service.failDispatch(schedule, claimToken, message);
      this.logger.warn(
        { err, sessionId: schedule.sessionId, scheduleId: schedule.scheduleId },
        "scheduled intervention failed",
      );
    }
  }
}

function buildScheduledPrompt(schedule: SoulstreamSchedule): string {
  const header = schedule.kind === "wakeup"
    ? "Scheduled wakeup"
    : `Scheduled cron${schedule.cronExpression ? ` (${schedule.cronExpression})` : ""}`;
  return `[${header}]\n\n${schedule.prompt}`;
}
