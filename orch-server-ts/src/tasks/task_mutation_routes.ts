import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SerializedTaskItem } from "./task_read_routes.js";
import {
  parseArchiveTaskPayload,
  parseCreateTaskPayload,
  parseHoldTaskPayload,
  parseLinkTaskPayload,
  parseMoveTaskPayload,
  parsePinTaskPayload,
  parseTaskOperationsQuery,
  parseTaskStatusPayload,
  parseUpdateTaskPayload,
  type ArchiveTaskPayload,
  type CreateTaskPayload,
  type HoldTaskPayload,
  type LinkTaskPayload,
  type MoveTaskPayload,
  type PayloadValidation,
  type PinTaskPayload,
  type TaskOperationsQuery,
  type TaskStatusPayload,
  type UpdateTaskPayload,
} from "./task_mutation_payloads.js";

export type SerializedTaskOperation = {
  id: string;
  taskId?: string | null;
  operationType: string;
  actorKind?: string | null;
  actorSessionId?: string | null;
  actorEventId?: number | null;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  payload?: unknown;
  reason?: string | null;
  createdAt?: string | null;
  [key: string]: unknown;
};

export type TaskMutationResponse = {
  task: SerializedTaskItem | null;
  operation: SerializedTaskOperation;
  eventId: number;
  idempotent?: boolean;
  [key: string]: unknown;
};

export type TaskMutationRouteProvider = {
  createTask: (
    payload: CreateTaskPayload,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
  setTaskStatus: (
    taskId: string,
    payload: TaskStatusPayload,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
  updateTask: (
    taskId: string,
    payload: UpdateTaskPayload,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
  moveTask: (
    taskId: string,
    payload: MoveTaskPayload,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
  linkTask: (
    taskId: string,
    payload: LinkTaskPayload,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
  holdTask: (
    taskId: string,
    payload: HoldTaskPayload,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
  archiveTask: (
    taskId: string,
    payload: ArchiveTaskPayload,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
  pinTask: (
    taskId: string,
    payload: PinTaskPayload,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
  listTaskOperations: (
    taskId: string,
    query: TaskOperationsQuery,
  ) => Promise<readonly SerializedTaskOperation[]> | readonly SerializedTaskOperation[];
};

export type TaskMutationRouteOptions = {
  provider: TaskMutationRouteProvider;
};

export class TaskMutationRouteError extends Error {
  readonly statusCode: number;
  readonly detail: string;

  constructor(statusCode: number, detail: string) {
    super(detail);
    this.name = "TaskMutationRouteError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

export const taskMutationRouteAuthRequirements = {
  "POST /api/tasks": true,
  "POST /api/tasks/:task_id/status": true,
  "PATCH /api/tasks/:task_id": true,
  "POST /api/tasks/:task_id/move": true,
  "POST /api/tasks/:task_id/link": true,
  "POST /api/tasks/:task_id/hold": true,
  "POST /api/tasks/:task_id/archive": true,
  "POST /api/tasks/:task_id/pin": true,
  "GET /api/tasks/:task_id/operations": true,
} as const;

type TaskParams = {
  task_id: string;
};

export function registerTaskMutationRoutes(
  app: FastifyInstance,
  options: TaskMutationRouteOptions,
): void {
  app.post("/api/tasks", async (request, reply) => {
    const payload = parseCreateTaskPayload(request.body);
    if (!payload.ok) return validationError(reply, payload);
    return sendMutationResult(reply, 201, () => options.provider.createTask(payload.value));
  });

  app.post<{ Params: TaskParams }>("/api/tasks/:task_id/status", async (request, reply) => {
    const payload = parseTaskStatusPayload(request.body);
    if (!payload.ok) return validationError(reply, payload);
    return sendMutationResult(reply, 200, () =>
      options.provider.setTaskStatus(taskIdParam(request), payload.value),
    );
  });

  app.patch<{ Params: TaskParams }>("/api/tasks/:task_id", async (request, reply) => {
    const payload = parseUpdateTaskPayload(request.body);
    if (!payload.ok) return validationError(reply, payload);
    return sendMutationResult(reply, 200, () =>
      options.provider.updateTask(taskIdParam(request), payload.value),
    );
  });

  app.post<{ Params: TaskParams }>("/api/tasks/:task_id/move", async (request, reply) => {
    const payload = parseMoveTaskPayload(request.body);
    if (!payload.ok) return validationError(reply, payload);
    return sendMutationResult(reply, 200, () =>
      options.provider.moveTask(taskIdParam(request), payload.value),
    );
  });

  app.post<{ Params: TaskParams }>("/api/tasks/:task_id/link", async (request, reply) => {
    const payload = parseLinkTaskPayload(request.body);
    if (!payload.ok) return validationError(reply, payload);
    return sendMutationResult(reply, 200, () =>
      options.provider.linkTask(taskIdParam(request), payload.value),
    );
  });

  app.post<{ Params: TaskParams }>("/api/tasks/:task_id/hold", async (request, reply) => {
    const payload = parseHoldTaskPayload(request.body);
    if (!payload.ok) return validationError(reply, payload);
    return sendMutationResult(reply, 200, () =>
      options.provider.holdTask(taskIdParam(request), payload.value),
    );
  });

  app.post<{ Params: TaskParams }>("/api/tasks/:task_id/archive", async (request, reply) => {
    const payload = parseArchiveTaskPayload(request.body);
    if (!payload.ok) return validationError(reply, payload);
    return sendMutationResult(reply, 200, () =>
      options.provider.archiveTask(taskIdParam(request), payload.value),
    );
  });

  app.post<{ Params: TaskParams }>("/api/tasks/:task_id/pin", async (request, reply) => {
    const payload = parsePinTaskPayload(request.body);
    if (!payload.ok) return validationError(reply, payload);
    return sendMutationResult(reply, 200, () =>
      options.provider.pinTask(taskIdParam(request), payload.value),
    );
  });

  app.get<{ Params: TaskParams }>(
    "/api/tasks/:task_id/operations",
    async (request, reply) => {
      const query = parseTaskOperationsQuery(request.query);
      if (!query.ok) return validationError(reply, query);
      try {
        const operations = await options.provider.listTaskOperations(
          taskIdParam(request),
          query.value,
        );
        return reply.send({ operations });
      } catch (error) {
        if (error instanceof TaskMutationRouteError) {
          return taskMutationRouteError(reply, error);
        }
        throw error;
      }
    },
  );
}

async function sendMutationResult(
  reply: FastifyReply,
  statusCode: number,
  handler: () => Promise<TaskMutationResponse> | TaskMutationResponse,
): Promise<FastifyReply> {
  try {
    return reply.code(statusCode).send(await handler());
  } catch (error) {
    if (error instanceof TaskMutationRouteError) {
      return taskMutationRouteError(reply, error);
    }
    throw error;
  }
}

function taskIdParam(request: FastifyRequest<{ Params: TaskParams }>): string {
  return request.params.task_id;
}

function validationError<T>(
  reply: FastifyReply,
  validation: Extract<PayloadValidation<T>, { ok: false }>,
): FastifyReply {
  return reply.code(validation.statusCode).send({ detail: validation.detail });
}

function taskMutationRouteError(
  reply: FastifyReply,
  error: TaskMutationRouteError,
): FastifyReply {
  return reply.code(error.statusCode).send({ detail: error.detail });
}
