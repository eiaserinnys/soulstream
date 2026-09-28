import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PersistenceHostRepositories } from "../control_plane/persistence_host_runtime.js";
import type { SoulstreamScheduleRepository } from "../schedule/schedule_repository.js";
import type {
  ScheduleCreateInput,
  SoulstreamSchedule,
  SoulstreamScheduleStatus,
} from "../schedule/schedule_types.js";
import {
  SessionResourceAccessError,
  type SessionResourceAccessProvider,
} from "./session_resource_access.js";

const SOURCE_TOOL = "ResumeAfterLimit";
const SCHEDULE_PROMPT = "리밋 해제 시각이 지났습니다. 이전 지시와 미완료 작업을 이어서 진행해주세요.";
const RESET_EVENT_TYPES = ["credential_alert", "error"];

const REUSABLE_SCHEDULE_STATUSES = new Set<SoulstreamScheduleStatus>([
  "active",
  "dispatching",
  "firing",
  "orphaned",
]);

type SessionParams = { session_id: string };

export type SessionResumeAfterLimitRouteOptions = {
  accessProvider: SessionResourceAccessProvider;
  persistenceRepositoryProvider: () => Promise<Pick<PersistenceHostRepositories, "sessionReads" | "eventReads">>;
  scheduleRepositoryProvider: () => Promise<Pick<
    SoulstreamScheduleRepository,
    "listSchedulesBySourceToolUseId" | "createScheduleIfAbsent"
  >>;
  now?: () => Date;
};

type ResumeAfterLimitScheduleView = {
  schedule_id: string;
  run_at: string;
  status: SoulstreamScheduleStatus;
};

type ResumeAfterLimitEligibility = {
  eligible: boolean;
  reason: string | null;
  resets_at: string | null;
  schedule: ResumeAfterLimitScheduleView | null;
  terminalEventId: number | null;
  toolUseId: string | null;
  schedules: SoulstreamSchedule[];
};

export const sessionResumeAfterLimitRouteAuthRequirements = {
  "GET /api/sessions/:session_id/resume-after-limit": true,
  "POST /api/sessions/:session_id/resume-after-limit": true,
} as const;

export function registerSessionResumeAfterLimitRoutes(
  app: FastifyInstance,
  dependencies: SessionResumeAfterLimitRouteOptions,
): void {
  app.get<{ Params: SessionParams }>(
    "/api/sessions/:session_id/resume-after-limit",
    async (request, reply) => {
      if (!await ensureSessionAccess(dependencies, request, reply)) return;

      const eligibility = await resolveEligibility(
        dependencies,
        request.params.session_id,
      );
      if (!eligibility.ok) return sendRouteError(reply, eligibility.status, eligibility.code, eligibility.message);
      return reply.send(publicEligibility(eligibility.value));
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/resume-after-limit",
    async (request, reply) => {
      if (!await ensureSessionAccess(dependencies, request, reply)) return;
      if (!isEmptyJsonObject(request.body)) {
        return sendRouteError(reply, 400, "INVALID_REQUEST", "Expected an empty JSON object.");
      }

      const sessionId = request.params.session_id;
      const eligibility = await resolveEligibility(dependencies, sessionId);
      if (!eligibility.ok) return sendRouteError(reply, eligibility.status, eligibility.code, eligibility.message);
      if (!eligibility.value.eligible || eligibility.value.resets_at === null
        || eligibility.value.terminalEventId === null || eligibility.value.toolUseId === null) {
        return sendRouteError(
          reply,
          409,
          "RATE_LIMIT_RESET_UNAVAILABLE",
          eligibility.value.reason ?? "제한 해제 시각을 확인할 수 없습니다.",
        );
      }

      if (eligibility.value.schedule !== null) {
        return reply.send({ ...eligibility.value.schedule, reused: true });
      }

      const scheduleRepository = await dependencies.scheduleRepositoryProvider();
      let generation = eligibility.value.schedules.length;
      while (true) {
        const now = dependencies.now?.() ?? new Date();
        const resetMs = Date.parse(eligibility.value.resets_at);
        const runAt = new Date(Math.max(resetMs, now.getTime()));
        const input: ScheduleCreateInput = {
          scheduleId: stableScheduleId(sessionId, eligibility.value.terminalEventId, generation),
          sessionId,
          kind: "wakeup",
          prompt: SCHEDULE_PROMPT,
          sourceTool: SOURCE_TOOL,
          toolUseId: eligibility.value.toolUseId,
          timezone: "UTC",
          recurring: false,
          runOnceAt: runAt,
          nextRunAt: runAt,
          createdAt: now,
        };
        const created = await scheduleRepository.createScheduleIfAbsent(input);
        if (created) return reply.send(scheduleResponse(created, false));

        const schedules = await scheduleRepository.listSchedulesBySourceToolUseId(
          sessionId,
          SOURCE_TOOL,
          eligibility.value.toolUseId,
        );
        const reusable = latestReusableSchedule(schedules);
        if (reusable) return reply.send(scheduleResponse(reusable, true));
        generation = schedules.length;
      }
    },
  );
}

async function resolveEligibility(
  dependencies: SessionResumeAfterLimitRouteOptions,
  sessionId: string,
): Promise<
  | { ok: true; value: ResumeAfterLimitEligibility }
  | { ok: false; status: number; code: string; message: string }
> {
  const repositories = await dependencies.persistenceRepositoryProvider();
  const session = await repositories.sessionReads.getSession(sessionId);
  if (!session) {
    return { ok: false, status: 404, code: "SESSION_NOT_FOUND", message: "Session not found." };
  }

  const terminalEventId = positiveEventId(session.termination_event_id);
  if (session.status !== "error" || session.termination_reason !== "limit_hit" || terminalEventId === null) {
    return ineligible("현재 세션이 사용량 제한으로 중단된 상태가 아닙니다.");
  }

  const terminalEvents = await repositories.eventReads.readRecentEvents(sessionId, 2, ["session_ended"]);
  const latestTerminal = terminalEvents.at(-1);
  if (latestTerminal?.id !== terminalEventId || latestTerminal.payload.termination_reason !== "limit_hit") {
    return ineligible("현재 세션의 제한 중단 기록을 확인할 수 없습니다.");
  }

  const previousTerminalId = terminalEvents.length > 1
    ? terminalEvents[terminalEvents.length - 2]!.id
    : 0;
  const resetEvents = await repositories.eventReads.readEventsBetween(
    sessionId,
    previousTerminalId,
    terminalEventId,
    RESET_EVENT_TYPES,
  );
  const resetsAt = latestValidResetAt(resetEvents);
  if (resetsAt === null) {
    return ineligible("제한 해제 시각을 확인할 수 없습니다.");
  }

  const toolUseId = `${SOURCE_TOOL}:${terminalEventId}`;
  const scheduleRepository = await dependencies.scheduleRepositoryProvider();
  const schedules = await scheduleRepository.listSchedulesBySourceToolUseId(
    sessionId,
    SOURCE_TOOL,
    toolUseId,
  );
  const active = latestReusableSchedule(schedules);
  return {
    ok: true,
    value: {
      eligible: true,
      reason: null,
      resets_at: resetsAt,
      schedule: active ? scheduleView(active) : null,
      terminalEventId,
      toolUseId,
      schedules,
    },
  };
}

function latestValidResetAt(events: Array<{ event_type: string; payload: Record<string, unknown> }>): string | null {
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const payload = event.payload;
    const isRejectedCredential = event.event_type === "credential_alert" && payload.status === "rejected";
    const isRateLimitError = event.event_type === "error"
      && payload.error_code === "claude_rate_limit_stop_failure"
      && payload.fatal === true;
    if (!isRejectedCredential && !isRateLimitError) continue;
    if (typeof payload.resets_at !== "string") continue;
    const resetMs = Date.parse(payload.resets_at);
    if (!Number.isFinite(resetMs)) continue;
    latestMs = Math.max(latestMs, resetMs);
  }
  return Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null;
}

function latestReusableSchedule(schedules: SoulstreamSchedule[]): SoulstreamSchedule | null {
  return [...schedules].reverse().find((schedule) => REUSABLE_SCHEDULE_STATUSES.has(schedule.status)) ?? null;
}

function stableScheduleId(sessionId: string, terminalEventId: number, generation: number): string {
  return `resume-after-limit:${sessionId}:${terminalEventId}:${generation}`;
}

function scheduleView(schedule: SoulstreamSchedule): ResumeAfterLimitScheduleView {
  return {
    schedule_id: schedule.scheduleId,
    run_at: schedule.nextRunAt ?? schedule.runOnceAt ?? schedule.createdAt,
    status: schedule.status,
  };
}

function publicEligibility(eligibility: ResumeAfterLimitEligibility) {
  return {
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    resets_at: eligibility.resets_at,
    schedule: eligibility.schedule,
  };
}

function scheduleResponse(schedule: SoulstreamSchedule, reused: boolean) {
  return { ...scheduleView(schedule), reused };
}

function ineligible(reason: string): { ok: true; value: ResumeAfterLimitEligibility } {
  return {
    ok: true,
    value: {
      eligible: false,
      reason,
      resets_at: null,
      schedule: null,
      terminalEventId: null,
      toolUseId: null,
      schedules: [],
    },
  };
}

function positiveEventId(value: unknown): number | null {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isEmptyJsonObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0;
}

async function ensureSessionAccess(
  dependencies: SessionResumeAfterLimitRouteOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    await dependencies.accessProvider.requireSessionAccess({
      request,
      sessionId: (request.params as SessionParams).session_id,
    });
    return true;
  } catch (error) {
    if (!(error instanceof SessionResourceAccessError)) throw error;
    sendRouteError(reply, error.statusCode, error.code, error.message);
    return false;
  }
}

function sendRouteError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}
