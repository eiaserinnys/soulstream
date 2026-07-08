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

export type SessionBackgroundScheduleRouteOptions =
  SessionBackgroundScheduleCommandDispatchOptions;

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
    async (request, reply) =>
      sendBackgroundScheduleCommand(
        reply,
        options,
        listTasksPayload(sessionParams(request).session_id),
      ),
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:session_id/background-tasks/background",
    async (request, reply) => {
      const payload = backgroundTasksPayload(
        sessionParams(request).session_id,
        request.body,
      );
      if (!payload.ok) return badRequest(reply, payload.message);
      return sendBackgroundScheduleCommand(reply, options, payload.value);
    },
  );

  app.get<{ Params: TaskParams }>(
    "/api/sessions/:session_id/background-tasks/:task_id/output",
    async (request, reply) =>
      sendBackgroundScheduleCommand(
        reply,
        options,
        taskOutputPayload(taskParams(request)),
      ),
  );

  app.post<{ Params: TaskParams }>(
    "/api/sessions/:session_id/background-tasks/:task_id/stop",
    async (request, reply) =>
      sendBackgroundScheduleCommand(
        reply,
        options,
        stopTaskPayload(taskParams(request)),
      ),
  );

  app.get<{ Params: SessionParams }>(
    "/api/sessions/:session_id/schedules",
    async (request, reply) =>
      sendBackgroundScheduleCommand(
        reply,
        options,
        listSchedulesPayload(sessionParams(request).session_id),
      ),
  );

  app.delete<{ Params: ScheduleParams }>(
    "/api/sessions/:session_id/schedules/:schedule_id",
    async (request, reply) =>
      sendDeleteScheduleCommand(
        reply,
        options,
        deleteSchedulePayload(scheduleParams(request)),
      ),
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
