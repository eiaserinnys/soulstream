import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { TaskControlPlaneService } from "./task_control_plane_service.js";

export interface TaskControlPlaneHostRouteOptions {
  serviceProvider: () => Promise<TaskControlPlaneService>;
  authBearerToken: string;
}

const readOperations = new Set([
  "get_task",
  "list_tasks",
  "list_my_turn_items",
  "list_operations",
  "list_agent_subscribers",
]);
const operations = new Set([
  ...readOperations,
  "set_task_status",
  "create_section",
  "patch_section",
  "set_section_assignee",
  "move_section",
  "create_item",
  "patch_item",
  "set_item_assignee",
  "move_item",
  "set_item_status",
]);

export function registerTaskControlPlaneHostRoute(
  app: FastifyInstance,
  options: TaskControlPlaneHostRouteOptions,
): void {
  app.post<{ Params: { operation: string } }>(
    "/api/tasks/host/:operation",
    async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
      );
      if (!authorization.ok) {
        return errorReply(reply, 401, "UNAUTHORIZED", `bearer token is ${authorization.reason}`);
      }
      const body = record(request.body);
      if (!body) return errorReply(reply, 422, "INVALID_TASK_HOST_REQUEST", "body must be an object");
      const operation = request.params.operation;
      if (!operations.has(operation)) {
        return errorReply(reply, 404, "TASK_HOST_OPERATION_NOT_FOUND", `unknown operation: ${operation}`);
      }
      if (!readOperations.has(operation)) {
        const actorError = validateActor(body);
        if (actorError) return errorReply(reply, 422, "INVALID_TASK_HOST_ACTOR", actorError);
      }
      try {
        const service = await options.serviceProvider();
        return reply.send(await dispatch(service, operation, camelizeRecord(body)));
      } catch (error) {
        request.log.error({ err: error, operation }, "Task control-plane host operation failed");
        const status = errorStatus(error);
        return errorReply(
          reply,
          status,
          status === 409
            ? "TASK_VERSION_CONFLICT"
            : status === 404
              ? "TASK_HOST_OPERATION_NOT_FOUND"
              : "TASK_HOST_OPERATION_FAILED",
          error instanceof Error ? error.message : "Task control-plane host operation failed",
          conflictDetails(error),
        );
      }
    },
  );
}

async function dispatch(
  service: TaskControlPlaneService,
  operation: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (operation) {
    case "get_task":
      return await service.getTask(requiredString(input, "taskId"));
    case "list_tasks":
      return await service.listTasks(input as unknown as Parameters<TaskControlPlaneService["listTasks"]>[0]);
    case "list_my_turn_items":
      return await service.listMyTurnItems(input as unknown as Parameters<TaskControlPlaneService["listMyTurnItems"]>[0]);
    case "list_operations":
      return await service.listOperations(requiredString(input, "taskId"), optionalNumber(input, "limit"));
    case "list_agent_subscribers":
      return await service.listAgentSubscriberSessionIds(requiredString(input, "taskId"));
    case "set_task_status":
      return await service.setTaskStatus(input as unknown as Parameters<TaskControlPlaneService["setTaskStatus"]>[0]);
    case "create_section":
      return await service.createSection(input as unknown as Parameters<TaskControlPlaneService["createSection"]>[0]);
    case "patch_section":
      return await service.patchSection(input as unknown as Parameters<TaskControlPlaneService["patchSection"]>[0]);
    case "set_section_assignee":
      return await service.setSectionAssignee(input as unknown as Parameters<TaskControlPlaneService["setSectionAssignee"]>[0]);
    case "move_section":
      return await service.moveSection(input as unknown as Parameters<TaskControlPlaneService["moveSection"]>[0]);
    case "create_item":
      return await service.createItem(input as unknown as Parameters<TaskControlPlaneService["createItem"]>[0]);
    case "patch_item":
      return await service.patchItem(input as unknown as Parameters<TaskControlPlaneService["patchItem"]>[0]);
    case "set_item_assignee":
      return await service.setItemAssignee(input as unknown as Parameters<TaskControlPlaneService["setItemAssignee"]>[0]);
    case "move_item":
      return await service.moveItem(input as unknown as Parameters<TaskControlPlaneService["moveItem"]>[0]);
    case "set_item_status":
      return await service.setItemStatus(input as unknown as Parameters<TaskControlPlaneService["setItemStatus"]>[0]);
    default:
      throw Object.assign(new Error(`unknown operation: ${operation}`), { statusCode: 404 });
  }
}

function validateActor(body: Record<string, unknown>): string | null {
  const kind = body.actor_kind;
  if (!(["agent", "user", "system", "llm"] as const).includes(kind as never)) {
    return "actor_kind is required";
  }
  if (kind === "agent" && !nonEmpty(body.actor_session_id)) return "actor_session_id is required";
  if (kind === "user" && !nonEmpty(body.actor_user_id)) return "actor_user_id is required";
  return null;
}

function camelizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [camelKey(key), camelize(child)]));
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  const object = record(value);
  return object ? camelizeRecord(object) : value;
}

function camelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (!nonEmpty(value)) throw Object.assign(new Error(`${key} is required`), { statusCode: 422 });
  return value;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw Object.assign(new Error(`${key} must be an integer`), { statusCode: 422 });
  }
  return value;
}

function errorStatus(error: unknown): number {
  const status = record(error)?.statusCode;
  return typeof status === "number" ? status : 500;
}

function conflictDetails(error: unknown): Record<string, unknown> | undefined {
  const value = record(error);
  if (value?.statusCode !== 409) return undefined;
  return {
    targetKind: value.targetKind,
    targetId: value.targetId,
    expectedVersion: value.expectedVersion,
    actualVersion: value.actualVersion,
  };
}

function errorReply(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return reply.code(status).send({
    detail: { error: { code, message, ...(details ? { details } : {}) } },
  });
}
