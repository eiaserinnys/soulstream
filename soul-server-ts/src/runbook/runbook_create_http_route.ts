import type { FastifyInstance } from "fastify";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";

import type { RunbookService } from "./runbook_service.js";

interface CreateRunbookRequestBody {
  runbook_id?: unknown;
  title?: unknown;
  folder_id?: unknown;
}

export function registerRunbookCreateHttpRoute(
  fastify: FastifyInstance,
  config: { service: RunbookService; auth: BoardYjsAuthConfig },
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
        const result = await config.service.createRunbook({
          actorKind: "user",
          actorSessionId: null,
          actorUserId: userId,
          runbookId: parsed.value.runbookId,
          title: parsed.value.title,
          folderId: parsed.value.folderId,
          enrollCreator: false,
        });
        return reply.status(201).send({
          ok: true,
          runbookId: result.snapshot.runbook.id,
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
  | { ok: true; value: { runbookId?: string; title: string; folderId: string } }
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
  return {
    ok: true,
    value: {
      title: body.title.trim(),
      folderId: body.folder_id.trim(),
      ...(typeof body.runbook_id === "string"
        ? { runbookId: body.runbook_id.trim() }
        : {}),
    },
  };
}
