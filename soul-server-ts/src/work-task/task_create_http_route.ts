import { randomUUID } from "node:crypto";
import {
  parseInitialTaskContextWire,
  type InitialTaskContext,
} from "@soulstream/page-model";

import type { FastifyInstance } from "fastify";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";

import type { TaskIdentityHostClient } from "./task_identity_host_client.js";

interface CreateTaskRequestBody {
  task_id?: unknown;
  title?: unknown;
  description?: unknown;
  folder_id?: unknown;
  idempotency_key?: unknown;
  initial_context?: unknown;
}

export function registerTaskCreateHttpRoute(
  fastify: FastifyInstance,
  config: { taskIdentityHost: TaskIdentityHostClient; auth: BoardYjsAuthConfig },
): void {
  fastify.post<{ Body: CreateTaskRequestBody }>(
    "/api/tasks",
    async (request, reply) => {
      let userId: string;
      try {
        userId = (await authenticateDashboardHttpRequest({
          requestHeaders: request.headers,
          config: config.auth,
        })).subject;
      } catch (err) {
        return reply.status(401).send({
          detail: {
            error: {
              code: "UNAUTHORIZED",
              message: err instanceof Error ? err.message : "Authentication failed",
            },
          },
        });
      }

      const parsed = parseCreateTaskBody(request.body ?? {});
      if (!parsed.ok) {
        return reply.status(422).send({
          detail: {
            error: {
              code: "INVALID_TASK_CREATE_REQUEST",
              message: parsed.error,
            },
          },
        });
      }

      try {
        const result = await config.taskIdentityHost.create({
          actorKind: "user",
          actorSessionId: null,
          actorUserId: userId,
          taskId: parsed.value.taskId,
          title: parsed.value.title,
          description: parsed.value.description,
          folderId: parsed.value.folderId,
          ...(parsed.value.initialContext ? { initialContext: parsed.value.initialContext } : {}),
          idempotencyKey: parsed.value.idempotencyKey
            ?? `create_task:${userId}:${randomUUID()}`,
        });
        return reply.status(201).send({
          ok: true,
          id: result.id,
          pageId: result.pageId,
          taskId: result.taskId,
          operation: result.operation,
          snapshot: result.snapshot,
        });
      } catch (err) {
        request.log.error({ err }, "Task creation failed");
        return reply.status(500).send({
          detail: {
            error: {
              code: "TASK_CREATE_FAILED",
              message: err instanceof Error ? err.message : "Task creation failed",
            },
          },
        });
      }
    },
  );
}

function parseCreateTaskBody(body: CreateTaskRequestBody):
  | { ok: true; value: {
    taskId?: string;
    title: string;
    description?: string;
    folderId: string;
    idempotencyKey?: string;
    initialContext?: InitialTaskContext;
  } }
  | { ok: false; error: string } {
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (typeof body.folder_id !== "string" || body.folder_id.trim().length === 0) {
    return { ok: false, error: "folder_id must be a non-empty string" };
  }
  if (
    body.task_id !== undefined &&
    (typeof body.task_id !== "string" || body.task_id.trim().length === 0)
  ) {
    return { ok: false, error: "task_id must be a non-empty string when provided" };
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    return { ok: false, error: "description must be a string when provided" };
  }
  if (
    body.idempotency_key !== undefined
    && (typeof body.idempotency_key !== "string" || body.idempotency_key.trim().length === 0)
  ) {
    return { ok: false, error: "idempotency_key must be a non-empty string when provided" };
  }
  const initialContext = parseInitialTaskContextWire(body.initial_context);
  if (!initialContext.ok) return { ok: false, error: initialContext.error };
  return {
    ok: true,
    value: {
      title: body.title.trim(),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      folderId: body.folder_id.trim(),
      ...(typeof body.idempotency_key === "string"
        ? { idempotencyKey: body.idempotency_key.trim() }
        : {}),
      ...(typeof body.task_id === "string"
        ? { taskId: body.task_id.trim() }
        : {}),
      ...(initialContext.value ? { initialContext: initialContext.value } : {}),
    },
  };
}
