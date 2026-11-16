import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  badRequest,
  sendBackgroundScheduleCommand,
  sendDeleteScheduleCommand,
  type SessionBackgroundScheduleCommandDispatchOptions,
} from "./session_background_schedule_errors.js";
import {
  backgroundTasksPayload,
  deleteSchedulePayload,
  listSchedulesPayload,
  listTasksPayload,
  stopTaskPayload,
  taskOutputPayload,
  type ScheduleParams,
  type SessionParams,
  type TaskParams,
} from "./session_background_schedule_payloads.js";
import {
  requireRequestSessionAccess,
  type SessionResourceAccessProvider,
} from "./session_resource_access.js";

export type SessionBackgroundScheduleRouteOptions =
  SessionBackgroundScheduleCommandDispatchOptions & {
    /** Session folder ACL for the HTTP handlers only. */
    accessProvider?: SessionResourceAccessProvider;
  };

export const sessionBackgroundScheduleRouteAuthRequirements = {
  "GET /api/sessions/:session_id/background-tasks": true,
  "GET /api/sessions/:session_id/background-tasks/:task_id/output": true,
  "POST /api/sessions/:session_id/background-tasks/:task_id/stop": true,
  "POST /api/sessions/:session_id/background-tasks/background": true,
  "GET /api/sessions/:session_id/schedules": true,
  "DELETE /api/sessions/:session_id/schedules/:schedule_id": true,
} as const;

export function registerSessionBackgroundScheduleRoutes(
  app: FastifyInstance,
  options: SessionBackgroundScheduleRouteOptions,
): void {
  app.get<{ Params: SessionParams }>(
    "/api/sessions/:session_id/background-tasks",
    async (request, reply) => {
      const sessionId = sessionParams(request).session_id;
      const denied = await requireRequestSessionAccess(
        options.accessProvider,
        request,
        reply,
        sessionId,
      );
      if (denied) return reply;
      return sendBackgroundScheduleCommand(
        reply,
        options,
        listTasksPayload(sessionId),
      );
    },
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/background-tasks/background",
    async (request, reply) => {
      const sessionId = sessionParams(request).session_id;
      const denied = await requireRequestSessionAccess(
        options.accessProvider,
        request,
        reply,
        sessionId,
      );
      if (denied) return reply;
      const payload = backgroundTasksPayload(sessionId, request.body);
      if (!payload.ok) return badRequest(reply, payload.message);
      return sendBackgroundScheduleCommand(reply, options, payload.value);
    },
  );

  app.get<{ Params: TaskParams }>(
    "/api/sessions/:session_id/background-tasks/:task_id/output",
    async (request, reply) => {
      const params = taskParams(request);
      const denied = await requireRequestSessionAccess(
        options.accessProvider,
        request,
        reply,
        params.session_id,
      );
      if (denied) return reply;
      return sendBackgroundScheduleCommand(
        reply,
        options,
        taskOutputPayload(params),
      );
    },
  );

  app.post<{ Params: TaskParams }>(
    "/api/sessions/:session_id/background-tasks/:task_id/stop",
    async (request, reply) => {
      const params = taskParams(request);
      const denied = await requireRequestSessionAccess(
        options.accessProvider,
        request,
        reply,
        params.session_id,
      );
      if (denied) return reply;
      return sendBackgroundScheduleCommand(
        reply,
        options,
        stopTaskPayload(params),
      );
    },
  );

  app.get<{ Params: SessionParams }>(
    "/api/sessions/:session_id/schedules",
    async (request, reply) => {
      const sessionId = sessionParams(request).session_id;
      const denied = await requireRequestSessionAccess(
        options.accessProvider,
        request,
        reply,
        sessionId,
      );
      if (denied) return reply;
      return sendBackgroundScheduleCommand(
        reply,
        options,
        listSchedulesPayload(sessionId),
      );
    },
  );

  app.delete<{ Params: ScheduleParams }>(
    "/api/sessions/:session_id/schedules/:schedule_id",
    async (request, reply) => {
      const params = scheduleParams(request);
      const denied = await requireRequestSessionAccess(
        options.accessProvider,
        request,
        reply,
        params.session_id,
      );
      if (denied) return reply;
      return sendDeleteScheduleCommand(
        reply,
        options,
        deleteSchedulePayload(params),
      );
    },
  );
}

function sessionParams(request: FastifyRequest): SessionParams {
  return request.params as SessionParams;
}

function taskParams(request: FastifyRequest): TaskParams {
  return request.params as TaskParams;
}

function scheduleParams(request: FastifyRequest): ScheduleParams {
  return request.params as ScheduleParams;
}
