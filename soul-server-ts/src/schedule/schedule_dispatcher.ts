import type { Logger } from "pino";

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

export class ScheduleDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
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

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.runOnce(),
      this.config.intervalMs ?? 30_000,
    );
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const batchSize = this.config.batchSize ?? 25;
      const staleBefore = new Date(now.getTime() - (this.config.orphanNodeTtlMs ?? 300_000));
      await this.service.touchNodeHeartbeat(this.config.nodeId, now);
      await this.service.repairExpiredClaims(now, batchSize);
      await this.service.restoreOrphanSchedulesForLiveNodes(staleBefore, batchSize);
      if (this.canMarkOrphans(now)) {
        await this.service.markOrphanDueSchedules(now, staleBefore, batchSize);
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
    } finally {
      this.running = false;
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
