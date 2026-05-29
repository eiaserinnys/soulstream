import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { ScheduleToolUseHandler } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import { nextCronRunAt } from "./cron.js";
import {
  nextRunAtFromSchedules,
  scheduleToDeletedEvent,
  scheduleToUpdatedEvent,
  type ClaimedSchedule,
  type ScheduleCreateInput,
  type ScheduleDeleteResponse,
  type ScheduleListResponse,
  type SoulstreamSchedule,
} from "./schedule_models.js";
import type { SoulstreamScheduleRepository } from "./schedule_repository.js";

const SCHEDULE_TOOL_NAMES = new Set([
  "ScheduleWakeup",
  "CronCreate",
  "CronList",
  "CronDelete",
]);

export class SoulstreamScheduleService {
  constructor(
    private readonly db: Pick<
      SoulstreamScheduleRepository,
      | "createSchedule"
      | "listSchedules"
      | "cancelSchedule"
      | "touchNodeHeartbeat"
      | "claimDueSchedules"
      | "repairExpiredClaims"
      | "markOrphanDueSchedules"
      | "restoreOrphanSchedulesForLiveNodes"
      | "consumeClaimedSchedule"
      | "confirmScheduleStillFiring"
      | "deferScheduleDispatch"
      | "finishScheduleDispatch"
      | "failScheduleDispatch"
    >,
    private readonly broadcaster: SessionBroadcaster,
    private readonly persistence: EventPersistence,
    private readonly logger: Logger,
  ) {}

  handlesTool(toolName: string): boolean {
    return SCHEDULE_TOOL_NAMES.has(toolName);
  }

  makeToolHandler(): ScheduleToolUseHandler {
    return async (request) => {
      const toolInput = asRecord(request.input);
      if (!toolInput) {
        throw new Error(`${request.toolName} input must be an object`);
      }
      if (request.toolName === "CronList") {
        const response = await this.listSchedules(request.agentSessionId);
        return {
          message: formatScheduleListMessage(response),
          data: response,
        };
      }
      if (request.toolName === "CronDelete") {
        const scheduleId = readString(toolInput, "schedule_id")
          ?? readString(toolInput, "scheduleId")
          ?? readString(toolInput, "id")
          ?? readString(toolInput, "job_id")
          ?? readString(toolInput, "jobId");
        if (!scheduleId) throw new Error("CronDelete requires schedule_id");
        const response = await this.deleteSchedule(request.agentSessionId, scheduleId);
        return {
          message: formatScheduleDeleteMessage(response),
          data: response,
        };
      }

      const schedule = await this.createScheduleFromTool({
        agentSessionId: request.agentSessionId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: toolInput,
        now: request.now,
      });
      return {
        message: `Soulstream durable scheduler accepted ${request.toolName} as ${schedule.scheduleId}. Next run: ${schedule.nextRunAt}.`,
        data: schedule,
      };
    };
  }

  async createScheduleFromTool(params: {
    agentSessionId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    now: Date;
  }): Promise<SoulstreamSchedule> {
    const prompt =
      readString(params.input, "prompt")
      ?? readString(params.input, "message")
      ?? "Continue from the scheduled wakeup.";
    const scheduleId = randomUUID();
    let input: ScheduleCreateInput;

    if (params.toolName === "ScheduleWakeup") {
      const delaySeconds =
        readNumber(params.input, "delaySeconds")
        ?? readNumber(params.input, "delay_seconds")
        ?? readNumber(params.input, "seconds");
      const delayMs =
        readNumber(params.input, "delayMs")
        ?? readNumber(params.input, "delay_ms")
        ?? readNumber(params.input, "milliseconds");
      const wakeAtRaw =
        readString(params.input, "wake_at")
        ?? readString(params.input, "wakeAt")
        ?? readString(params.input, "run_at")
        ?? readString(params.input, "runAt")
        ?? readString(params.input, "at");
      const nextRunAt = wakeAtRaw
        ? parseDate(wakeAtRaw, "wake_at")
        : delayMs !== undefined
          ? new Date(params.now.getTime() + delayMs)
          : delaySeconds !== undefined
            ? new Date(params.now.getTime() + delaySeconds * 1000)
            : null;
      if (!nextRunAt || nextRunAt.getTime() <= params.now.getTime()) {
        throw new Error("ScheduleWakeup requires a future wake_at or positive delaySeconds");
      }
      input = {
        scheduleId,
        sessionId: params.agentSessionId,
        kind: "wakeup",
        prompt,
        sourceTool: params.toolName,
        toolUseId: params.toolUseId,
        timezone: "UTC",
        recurring: false,
        nextRunAt,
        runOnceAt: nextRunAt,
        createdAt: params.now,
      };
    } else if (params.toolName === "CronCreate") {
      const runOnceAtRaw =
        readString(params.input, "run_once_at")
        ?? readString(params.input, "runOnceAt");
      const cronExpression =
        readString(params.input, "cron_expression")
        ?? readString(params.input, "cronExpression")
        ?? readString(params.input, "cron")
        ?? readString(params.input, "expression")
        ?? readString(params.input, "schedule");
      const recurring = readBoolean(params.input, "recurring") ?? Boolean(cronExpression);
      const timezone = readString(params.input, "timezone") ?? "UTC";
      if (runOnceAtRaw) {
        const runOnceAt = parseDate(runOnceAtRaw, "run_once_at");
        input = {
          scheduleId,
          sessionId: params.agentSessionId,
          kind: "cron",
          prompt,
          sourceTool: params.toolName,
          toolUseId: params.toolUseId,
          timezone,
          recurring: false,
          cronExpression: null,
          runOnceAt,
          nextRunAt: runOnceAt,
          createdAt: params.now,
        };
      } else {
        if (!cronExpression) throw new Error("CronCreate requires cron_expression or run_once_at");
        input = {
          scheduleId,
          sessionId: params.agentSessionId,
          kind: "cron",
          prompt,
          sourceTool: params.toolName,
          toolUseId: params.toolUseId,
          timezone,
          recurring,
          cronExpression,
          runOnceAt: null,
          nextRunAt: nextCronRunAt(cronExpression, params.now, timezone),
          createdAt: params.now,
        };
      }
    } else {
      throw new Error(`Unsupported schedule tool: ${params.toolName}`);
    }

    const schedule = await this.db.createSchedule(input);
    await this.emitScheduleEvent(schedule, "updated");
    return schedule;
  }

  async listSchedules(sessionId: string): Promise<ScheduleListResponse> {
    const schedules = await this.db.listSchedules(sessionId);
    return {
      sessionId,
      schedules,
      nextRunAt: nextRunAtFromSchedules(
        schedules.filter((schedule) => schedule.status === "active"),
      ),
    };
  }

  async deleteSchedule(
    sessionId: string,
    scheduleId: string,
  ): Promise<ScheduleDeleteResponse> {
    const result = await this.db.cancelSchedule(sessionId, scheduleId);
    if (result.outcome === "not_found") {
      return { sessionId, scheduleId, status: "not_found", deleted: false, schedule: null };
    }
    const schedule = result.schedule;
    if (!schedule) {
      return { sessionId, scheduleId, status: "not_found", deleted: false, schedule: null };
    }
    if (result.outcome === "already_firing") {
      return { sessionId, scheduleId, status: "already_firing", deleted: false, schedule };
    }
    if (result.outcome !== "cancelled") {
      return { sessionId, scheduleId, status: schedule.status, deleted: false, schedule };
    }
    await this.emitScheduleEvent(schedule, "deleted");
    return { sessionId, scheduleId, status: schedule.status, deleted: true, schedule };
  }

  async claimDueSchedules(
    nodeId: string,
    now: Date,
    limit = 25,
    claimTimeoutMs = 60_000,
  ): Promise<ClaimedSchedule[]> {
    return await this.db.claimDueSchedules({
      nodeId,
      now,
      claimToken: randomUUID(),
      claimedUntil: new Date(now.getTime() + claimTimeoutMs),
      limit,
    });
  }

  async touchNodeHeartbeat(nodeId: string, now: Date): Promise<void> {
    await this.db.touchNodeHeartbeat(nodeId, now);
  }

  async repairExpiredClaims(
    now: Date,
    limit = 25,
  ): Promise<SoulstreamSchedule[]> {
    const schedules = await this.db.repairExpiredClaims({
      now,
      limit,
      error: "schedule dispatch claim expired; restored for retry",
    });
    for (const schedule of schedules) {
      await this.emitScheduleEvent(schedule, "updated");
    }
    return schedules;
  }

  async markOrphanDueSchedules(
    now: Date,
    staleBefore: Date,
    limit = 25,
  ): Promise<SoulstreamSchedule[]> {
    const schedules = await this.db.markOrphanDueSchedules({
      now,
      staleBefore,
      limit,
      error: "scheduled session owner node is not connected",
    });
    for (const schedule of schedules) {
      await this.emitScheduleEvent(schedule, "updated");
    }
    return schedules;
  }

  async restoreOrphanSchedulesForLiveNodes(
    staleBefore: Date,
    limit = 25,
  ): Promise<SoulstreamSchedule[]> {
    const schedules = await this.db.restoreOrphanSchedulesForLiveNodes({
      staleBefore,
      limit,
    });
    for (const schedule of schedules) {
      await this.emitScheduleEvent(schedule, "updated");
    }
    return schedules;
  }

  async consumeClaimedSchedule(
    scheduleId: string,
    claimToken: string,
  ): Promise<SoulstreamSchedule | null> {
    return await this.db.consumeClaimedSchedule(scheduleId, claimToken);
  }

  async confirmScheduleStillFiring(
    scheduleId: string,
    claimToken: string,
  ): Promise<SoulstreamSchedule | null> {
    return await this.db.confirmScheduleStillFiring(scheduleId, claimToken);
  }

  async deferDispatch(
    schedule: SoulstreamSchedule,
    claimToken: string,
    nextRunAt: Date,
    error: string,
  ): Promise<SoulstreamSchedule | null> {
    const updated = await this.db.deferScheduleDispatch({
      scheduleId: schedule.scheduleId,
      claimToken,
      nextRunAt,
      error,
    });
    if (updated) await this.emitScheduleEvent(updated, "updated");
    return updated;
  }

  async finishDispatch(
    schedule: SoulstreamSchedule,
    claimToken: string,
    now: Date,
  ): Promise<SoulstreamSchedule | null> {
    const nextRunAt = schedule.recurring && schedule.cronExpression
      ? nextCronRunAt(schedule.cronExpression, now, schedule.timezone)
      : null;
    const updated = await this.db.finishScheduleDispatch({
      scheduleId: schedule.scheduleId,
      claimToken,
      recurring: schedule.recurring,
      nextRunAt,
      firedAt: now,
    });
    if (updated) await this.emitScheduleEvent(updated, "updated");
    return updated;
  }

  async failDispatch(
    schedule: SoulstreamSchedule,
    claimToken: string,
    error: string,
  ): Promise<SoulstreamSchedule | null> {
    const updated = await this.db.failScheduleDispatch(
      schedule.scheduleId,
      claimToken,
      error,
    );
    if (updated) await this.emitScheduleEvent(updated, "updated");
    return updated;
  }

  private async emitScheduleEvent(
    schedule: SoulstreamSchedule,
    kind: "updated" | "deleted",
  ): Promise<void> {
    const event = kind === "updated"
      ? scheduleToUpdatedEvent(schedule)
      : scheduleToDeletedEvent(schedule);
    try {
      const eventId = await this.persistence.persistEvent(schedule.sessionId, event);
      (event as Record<string, unknown>)._event_id = eventId;
    } catch (err) {
      this.logger.warn(
        { err, sessionId: schedule.sessionId, scheduleId: schedule.scheduleId },
        "schedule event persistence failed",
      );
    }
    await this.broadcaster.emitEventEnvelope(schedule.sessionId, event);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

function parseDate(raw: string, label: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return date;
}

function formatScheduleListMessage(response: ScheduleListResponse): string {
  if (response.schedules.length === 0) {
    return "Soulstream durable scheduler has 0 schedules.";
  }
  const rows = response.schedules.map((schedule) => {
    const prompt = schedule.prompt.length > 80
      ? `${schedule.prompt.slice(0, 77)}...`
      : schedule.prompt;
    return [
      `id=${schedule.scheduleId}`,
      `kind=${schedule.kind}`,
      `status=${schedule.status}`,
      `nextRunAt=${schedule.nextRunAt ?? "none"}`,
      `prompt=${JSON.stringify(prompt)}`,
    ].join(" ");
  });
  return [
    `Soulstream durable scheduler has ${response.schedules.length} schedule(s).`,
    ...rows,
  ].join("\n");
}

function formatScheduleDeleteMessage(response: ScheduleDeleteResponse): string {
  if (response.deleted) {
    return `Soulstream durable scheduler deleted schedule ${response.scheduleId}.`;
  }
  if (response.status === "already_firing") {
    return `Soulstream durable scheduler cannot delete schedule ${response.scheduleId}: already_firing. The current firing is in progress; delete the next cron occurrence after it is rescheduled.`;
  }
  return `Soulstream durable scheduler did not delete schedule ${response.scheduleId}: ${response.status}.`;
}
