import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { SoulstreamScheduleRepository } from "./schedule_repository.js";

export interface ScheduleHostRouteOptions {
  repositoryProvider: () => Promise<SoulstreamScheduleRepository>;
  authBearerToken: string;
}

const operations = {
  create_schedule: "createSchedule",
  list_schedules: "listSchedules",
  cancel_schedule: "cancelSchedule",
  touch_node_heartbeat: "touchNodeHeartbeat",
  repair_expired_claims: "repairExpiredClaims",
  claim_due_schedules: "claimDueSchedules",
  mark_orphan_due_schedules: "markOrphanDueSchedules",
  restore_orphan_schedules_for_live_nodes: "restoreOrphanSchedulesForLiveNodes",
  consume_claimed_schedule: "consumeClaimedSchedule",
  confirm_schedule_still_firing: "confirmScheduleStillFiring",
  defer_schedule_dispatch: "deferScheduleDispatch",
  finish_schedule_dispatch: "finishScheduleDispatch",
  fail_schedule_dispatch: "failScheduleDispatch",
} as const;

export function registerScheduleHostRoute(app: FastifyInstance, options: ScheduleHostRouteOptions): void {
  app.post<{ Params: { operation: string } }>(
    "/api/schedules/host/:operation",
    async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
      );
      if (!authorization.ok) {
        return errorReply(reply, 401, "UNAUTHORIZED", `bearer token is ${authorization.reason}`);
      }
      const method = operations[request.params.operation as keyof typeof operations];
      if (!method) return errorReply(reply, 404, "SCHEDULE_OPERATION_NOT_FOUND", "unknown schedule operation");
      const body = toInput(request.body);
      if (!body) return errorReply(reply, 422, "INVALID_SCHEDULE_REQUEST", "body must be an object");
      try {
        const repository = await options.repositoryProvider();
        const result = await dispatch(repository, method, body);
        return reply.send(result ?? null);
      } catch (error) {
        request.log.error({ err: error, method }, "Schedule host operation failed");
        return errorReply(
          reply,
          500,
          "SCHEDULE_OPERATION_FAILED",
          error instanceof Error ? error.message : "Schedule host operation failed",
        );
      }
    },
  );
}

async function dispatch(
  repository: SoulstreamScheduleRepository,
  method: typeof operations[keyof typeof operations],
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "createSchedule": return await repository.createSchedule(input as never);
    case "listSchedules": return await repository.listSchedules(requiredString(input, "sessionId"));
    case "cancelSchedule": return await repository.cancelSchedule(
      requiredString(input, "sessionId"), requiredString(input, "scheduleId"),
    );
    case "touchNodeHeartbeat": return await repository.touchNodeHeartbeat(
      requiredString(input, "nodeId"),
    );
    case "repairExpiredClaims": return await repository.repairExpiredClaims(input as never);
    case "claimDueSchedules": return await repository.claimDueSchedules(input as never);
    case "markOrphanDueSchedules": return await repository.markOrphanDueSchedules(input as never);
    case "restoreOrphanSchedulesForLiveNodes":
      return await repository.restoreOrphanSchedulesForLiveNodes(input as never);
    case "consumeClaimedSchedule": return await repository.consumeClaimedSchedule(
      requiredString(input, "scheduleId"), requiredString(input, "claimToken"),
    );
    case "confirmScheduleStillFiring": return await repository.confirmScheduleStillFiring(
      requiredString(input, "scheduleId"), requiredString(input, "claimToken"),
    );
    case "deferScheduleDispatch": return await repository.deferScheduleDispatch(input as never);
    case "finishScheduleDispatch": return await repository.finishScheduleDispatch(input as never);
    case "failScheduleDispatch": return await repository.failScheduleDispatch(
      requiredString(input, "scheduleId"),
      requiredString(input, "claimToken"),
      requiredString(input, "error"),
    );
  }
}

const dateKeys = new Set(["runOnceAt", "nextRunAt", "createdAt", "now", "claimedUntil", "firedAt"]);

function toInput(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const camel = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return [camel, dateKeys.has(camel) && typeof child === "string" ? new Date(child) : child];
  }));
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function requiredDate(input: Record<string, unknown>, key: string): Date {
  const value = input[key];
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${key} is required`);
  return value;
}

function errorReply(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ detail: { error: { code, message } } });
}
