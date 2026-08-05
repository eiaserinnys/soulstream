import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";
import type {
  CancelScheduleResult,
  ClaimedSchedule,
  ScheduleCreateInput,
  SoulstreamSchedule,
} from "./schedule_models.js";

export class ScheduleHostClient {
  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {}

  createSchedule(input: ScheduleCreateInput): Promise<SoulstreamSchedule> {
    return this.request("create_schedule", input);
  }
  listSchedules(sessionId: string): Promise<SoulstreamSchedule[]> {
    return this.request("list_schedules", { sessionId });
  }
  cancelSchedule(sessionId: string, scheduleId: string): Promise<CancelScheduleResult> {
    return this.request("cancel_schedule", { sessionId, scheduleId });
  }
  async touchNodeHeartbeat(nodeId: string, now: Date): Promise<void> {
    await this.request("touch_node_heartbeat", { nodeId, now });
  }
  repairExpiredClaims(input: { now: Date; limit: number; error: string }): Promise<SoulstreamSchedule[]> {
    return this.request("repair_expired_claims", input);
  }
  claimDueSchedules(input: {
    nodeId: string; now: Date; claimToken: string; claimedUntil: Date; limit: number;
  }): Promise<ClaimedSchedule[]> {
    return this.request("claim_due_schedules", input);
  }
  markOrphanDueSchedules(input: {
    now: Date; staleBefore: Date; limit: number; error: string;
  }): Promise<SoulstreamSchedule[]> {
    return this.request("mark_orphan_due_schedules", input);
  }
  restoreOrphanSchedulesForLiveNodes(input: {
    staleBefore: Date; limit: number;
  }): Promise<SoulstreamSchedule[]> {
    return this.request("restore_orphan_schedules_for_live_nodes", input);
  }
  consumeClaimedSchedule(scheduleId: string, claimToken: string): Promise<SoulstreamSchedule | null> {
    return this.request("consume_claimed_schedule", { scheduleId, claimToken });
  }
  confirmScheduleStillFiring(scheduleId: string, claimToken: string): Promise<SoulstreamSchedule | null> {
    return this.request("confirm_schedule_still_firing", { scheduleId, claimToken });
  }
  deferScheduleDispatch(input: {
    scheduleId: string; claimToken: string; nextRunAt: Date; error: string;
  }): Promise<SoulstreamSchedule | null> {
    return this.request("defer_schedule_dispatch", input);
  }
  finishScheduleDispatch(input: {
    scheduleId: string; claimToken: string; recurring: boolean; nextRunAt: Date | null; firedAt: Date;
  }): Promise<SoulstreamSchedule | null> {
    return this.request("finish_schedule_dispatch", input);
  }
  failScheduleDispatch(scheduleId: string, claimToken: string, error: string): Promise<SoulstreamSchedule | null> {
    return this.request("fail_schedule_dispatch", { scheduleId, claimToken, error });
  }

  private async request<T>(operation: string, input: object): Promise<T> {
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/schedules/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(snakeCase(input)),
      },
    );
    if (!response.ok) {
      const message = await response.text();
      this.config.logger.warn({ operation, status: response.status, message }, "schedule host request failed");
      throw new Error(`schedule host ${operation} failed: ${message || response.statusText}`);
    }
    return await response.json() as T;
  }
}

function snakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCase);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        snakeCase(child),
      ]),
  );
}
