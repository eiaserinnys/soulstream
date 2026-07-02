import type { FastifyInstance } from "fastify";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";
import type {
  RunbookItemRow,
  RunbookItemStatus,
  RunbookRow,
  RunbookSectionRow,
} from "../db/session_db_types.js";

import { RunbookVersionConflict } from "./runbook_models.js";
import type { RunbookService } from "./runbook_service.js";

export interface RunbookHttpRouteConfig {
  service: RunbookService;
  auth: BoardYjsAuthConfig;
}

type MutableRunbookItemStatus = Extract<
  RunbookItemStatus,
  "pending" | "completed" | "cancelled"
>;

interface StatusRouteParams {
  runbookId: string;
  itemId: string;
}

interface StatusRequestBody {
  status?: unknown;
  expectedVersion?: unknown;
  expected_version?: unknown;
  idempotencyKey?: unknown;
  idempotency_key?: unknown;
  reason?: unknown;
}

export function registerRunbookHttpRoutes(
  fastify: FastifyInstance,
  config: RunbookHttpRouteConfig,
): void {
  fastify.post<{
    Params: StatusRouteParams;
    Body: StatusRequestBody;
  }>("/api/runbooks/:runbookId/items/:itemId/status", async (request, reply) => {
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

    const body = request.body ?? {};
    const parsed = parseStatusBody(body);
    if (!parsed.ok) {
      return reply.status(422).send({
        detail: {
          error: {
            code: "INVALID_RUNBOOK_STATUS_REQUEST",
            message: parsed.error,
          },
        },
      });
    }

    const snapshot = await config.service.getRunbook(request.params.runbookId);
    if (!snapshot) {
      return reply.status(404).send({
        detail: {
          error: {
            code: "RUNBOOK_NOT_FOUND",
            message: "Runbook not found",
          },
        },
      });
    }
    const item = snapshot.items.find((candidate) => candidate.id === request.params.itemId);
    if (!item) {
      return reply.status(404).send({
        detail: {
          error: {
            code: "RUNBOOK_ITEM_NOT_FOUND",
            message: "Runbook item not found",
          },
        },
      });
    }
    const section = snapshot.sections.find((candidate) => candidate.id === item.section_id) ?? null;
    const actorSessionId = resolveActorSessionId(snapshot.runbook, section, item);
    if (!actorSessionId) {
      return reply.status(422).send({
        detail: {
          error: {
            code: "RUNBOOK_ITEM_HAS_NO_SESSION_PROVENANCE",
            message: "Runbook item has no session provenance",
          },
        },
      });
    }

    try {
      const result = await config.service.setItemStatus({
        actorKind: "user",
        actorSessionId,
        actorUserId: userId,
        itemId: request.params.itemId,
        expectedVersion: parsed.value.expectedVersion,
        status: parsed.value.status,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      });

      return {
        ok: true,
        runbookId: result.snapshot.runbook.id,
        itemId: request.params.itemId,
        eventId: result.eventId,
        idempotent: Boolean(result.idempotent),
        operation: result.operation,
        snapshot: result.snapshot,
      };
    } catch (err) {
      if (err instanceof RunbookVersionConflict) {
        return reply.status(409).send({
          detail: {
            error: {
              code: "RUNBOOK_VERSION_CONFLICT",
              message: err.message,
              details: {
                targetKind: err.targetKind,
                targetId: err.targetId,
                expectedVersion: err.expectedVersion,
                actualVersion: err.actualVersion,
              },
            },
          },
        });
      }
      request.log.error({ err }, "Runbook item status update failed");
      return reply.status(500).send({
        detail: {
          error: {
            code: "RUNBOOK_STATUS_UPDATE_FAILED",
            message: err instanceof Error ? err.message : "Runbook status update failed",
          },
        },
      });
    }
  });
}

function parseStatusBody(body: StatusRequestBody): {
  ok: true;
  value: {
    status: MutableRunbookItemStatus;
    expectedVersion: number;
    idempotencyKey: string;
    reason: string | null;
  };
} | { ok: false; error: string } {
  const status = readMutableStatus(body.status);
  if (!status) {
    return { ok: false, error: "status must be pending, completed, or cancelled" };
  }

  const expectedVersion = readInteger(body.expectedVersion ?? body.expected_version);
  if (expectedVersion === null) {
    return { ok: false, error: "expectedVersion must be an integer" };
  }

  const idempotencyKey = readNonEmptyString(body.idempotencyKey ?? body.idempotency_key);
  if (!idempotencyKey) {
    return { ok: false, error: "idempotencyKey is required" };
  }

  const reasonValue = body.reason;
  const reason = reasonValue === undefined || reasonValue === null
    ? null
    : readNonEmptyString(reasonValue);
  if (reasonValue !== undefined && reasonValue !== null && reason === null) {
    return { ok: false, error: "reason must be a non-empty string when supplied" };
  }

  return {
    ok: true,
    value: {
      status,
      expectedVersion,
      idempotencyKey,
      reason,
    },
  };
}

function readMutableStatus(value: unknown): MutableRunbookItemStatus | null {
  if (value === "pending" || value === "completed" || value === "cancelled") {
    return value;
  }
  return null;
}

function readInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveActorSessionId(
  runbook: RunbookRow,
  section: RunbookSectionRow | null,
  item: RunbookItemRow,
): string | null {
  return item.assignee_session_id ||
    item.updated_session_id ||
    item.created_session_id ||
    section?.updated_session_id ||
    section?.created_session_id ||
    runbook.created_session_id ||
    null;
}
