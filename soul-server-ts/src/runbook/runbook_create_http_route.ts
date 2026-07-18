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

import type { RunbookTaskIdentityHostClient } from "./runbook_task_identity_host_client.js";

interface CreateRunbookRequestBody {
  runbook_id?: unknown;
  title?: unknown;
  description?: unknown;
  folder_id?: unknown;
  idempotency_key?: unknown;
  initial_context?: unknown;
}

export function registerRunbookCreateHttpRoute(
  fastify: FastifyInstance,
  config: { taskIdentityHost: RunbookTaskIdentityHostClient; auth: BoardYjsAuthConfig },
): void {
  fastify.post<{ Body: CreateRunbookRequestBody }>(
    "/api/runbooks",
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

      const parsed = parseCreateRunbookBody(request.body ?? {});
      if (!parsed.ok) {
        return reply.status(422).send({
          detail: {
            error: {
              code: "INVALID_RUNBOOK_CREATE_REQUEST",
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
          runbookId: parsed.value.runbookId,
          title: parsed.value.title,
          description: parsed.value.description,
          folderId: parsed.value.folderId,
          ...(parsed.value.initialContext ? { initialContext: parsed.value.initialContext } : {}),
          idempotencyKey: parsed.value.idempotencyKey
            ?? `create_runbook:${userId}:${randomUUID()}`,
        });
        return reply.status(201).send({
          ok: true,
          id: result.id,
          pageId: result.pageId,
          runbookId: result.runbookId,
          operation: result.operation,
          snapshot: result.snapshot,
        });
      } catch (err) {
        request.log.error({ err }, "Runbook creation failed");
        return reply.status(500).send({
          detail: {
            error: {
              code: "RUNBOOK_CREATE_FAILED",
              message: err instanceof Error ? err.message : "Runbook creation failed",
            },
          },
        });
      }
    },
  );
}

function parseCreateRunbookBody(body: CreateRunbookRequestBody):
  | { ok: true; value: {
    runbookId?: string;
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
    body.runbook_id !== undefined &&
    (typeof body.runbook_id !== "string" || body.runbook_id.trim().length === 0)
  ) {
    return { ok: false, error: "runbook_id must be a non-empty string when provided" };
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
      ...(typeof body.runbook_id === "string"
        ? { runbookId: body.runbook_id.trim() }
        : {}),
      ...(initialContext.value ? { initialContext: initialContext.value } : {}),
    },
  };
}
