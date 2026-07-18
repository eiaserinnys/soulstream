import { randomUUID } from "node:crypto";
import {
  parseInitialTaskContextWire,
  type InitialTaskContext,
} from "@soulstream/page-model";

import type { FastifyInstance } from "fastify";

import { isBoardFolderAllowed, normalizeBoardAccess } from "../board/board_access.js";
import { isTaskIdentityTitleConflictError } from "./task_identity_errors.js";
import type { TaskRouteOptions } from "./task_route_types.js";

interface CreateTaskBody {
  task_id?: string;
  title: string;
  description?: string;
  folder_id: string;
  idempotency_key?: string;
  initial_context?: unknown;
}

export function registerTaskCreateRoute(
  app: FastifyInstance,
  options: TaskRouteOptions,
): void {
  app.post("/api/tasks", async (request, reply) => {
    const body = parseCreateTaskBody(request.body);
    if (!body.ok) return reply.code(400).send({ detail: body.message });

    const folders = await options.provider.listFolders();
    if (!folders.some((folder) => folder.id === body.value.folder_id)) {
      return reply.code(404).send({ detail: "Folder not found" });
    }
    const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
    if (!isBoardFolderAllowed(access, folders, body.value.folder_id)) {
      return reply.code(403).send({ detail: "Folder access denied" });
    }
    if (!options.taskIdentityService) {
      return reply.code(503).send({ detail: "Task identity service is not configured" });
    }
    try {
      const userId = await options.resolveDashboardUserId?.(request);
      if (!userId) return reply.code(401).send({ detail: "Dashboard user is required" });
      const result = await options.taskIdentityService.create({
        title: body.value.title,
        description: body.value.description,
        folderId: body.value.folder_id,
        taskId: body.value.task_id,
        ...(body.value.initialContext ? { initialContext: body.value.initialContext } : {}),
        actor: { actorKind: "user", actorUserId: userId },
        idempotencyKey: body.value.idempotency_key ?? `create_task:${userId}:${randomUUID()}`,
      });
      return reply.code(201).send({
        ok: true,
        id: result.id,
        pageId: result.pageId,
        taskId: result.taskId,
        operation: result.operation,
        pageOperation: result.pageOperation,
        snapshot: result.snapshot,
      });
    } catch (error) {
      request.log.error({ err: error }, "Task identity creation failed");
      return reply.code(taskIdentityCreateErrorStatus(error)).send({
        detail: error instanceof Error ? error.message : "Task identity creation failed",
      });
    }
  });
}

function taskIdentityCreateErrorStatus(error: unknown): 409 | 422 | 500 {
  if (isTaskIdentityTitleConflictError(error)) return 409;
  if (!(error instanceof Error)) return 500;
  if (error.message === "new task identity id must be a UUID") return 422;
  if (error.message.startsWith("task identity already exists:")) return 409;
  return 500;
}

function parseCreateTaskBody(body: unknown):
  | { ok: true; value: CreateTaskBody & { initialContext?: InitialTaskContext } }
  | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "request body must be an object" };
  const title = nonEmptyString(body.title, "title");
  if (!title.ok) return title;
  const folderId = nonEmptyString(body.folder_id, "folder_id");
  if (!folderId.ok) return folderId;
  const description = body.description === undefined
    ? undefined
    : typeof body.description === "string" ? body.description : null;
  if (description === null) return { ok: false, message: "description must be a string" };
  const taskId = body.task_id === undefined
    ? undefined
    : nonEmptyString(body.task_id, "task_id");
  if (taskId && !taskId.ok) return taskId;
  const idempotencyKey = body.idempotency_key === undefined
    ? undefined
    : nonEmptyString(body.idempotency_key, "idempotency_key");
  if (idempotencyKey && !idempotencyKey.ok) return idempotencyKey;
  const initialContext = parseInitialTaskContextWire(body.initial_context);
  if (!initialContext.ok) return { ok: false, message: initialContext.error };
  return {
    ok: true,
    value: {
      ...(taskId ? { task_id: taskId.value } : {}),
      title: title.value,
      ...(description !== undefined ? { description } : {}),
      folder_id: folderId.value,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey.value } : {}),
      ...(initialContext.value ? { initialContext: initialContext.value } : {}),
    },
  };
}

function nonEmptyString(value: unknown, key: string):
  | { ok: true; value: string }
  | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, message: `${key} must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
