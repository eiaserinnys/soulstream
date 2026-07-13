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
  RunbookStatus,
} from "../db/session_db_types.js";
import type { ChecklistRunbookAdapter } from "../page/checklist_runbook_adapter.js";

import { RunbookVersionConflict } from "./runbook_models.js";
import type { RunbookService } from "./runbook_service.js";

export interface RunbookHttpRouteConfig {
  service: RunbookService;
  checklistAdapter?: Pick<ChecklistRunbookAdapter, "setChecked">;
  auth: BoardYjsAuthConfig;
}

type MutableRunbookItemStatus = Extract<
  RunbookItemStatus,
  "pending" | "review" | "completed" | "cancelled"
>;
type MutableRunbookStatus = Extract<RunbookStatus, "open" | "completed">;

interface RunbookItemStatusRouteParams {
  runbookId: string;
  itemId: string;
}

interface RunbookStatusRouteParams {
  runbookId: string;
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
    Params: RunbookStatusRouteParams;
    Body: StatusRequestBody;
  }>("/api/runbooks/:runbookId/status", async (request, reply) => {
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
    const parsed = parseRunbookStatusBody(body);
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
    const actorSessionId = resolveRunbookActorSessionId(snapshot.runbook);
    if (!actorSessionId) {
      return reply.status(422).send({
        detail: {
          error: {
            code: "RUNBOOK_HAS_NO_SESSION_PROVENANCE",
            message: "Runbook has no session provenance",
          },
        },
      });
    }

    try {
      const result = await config.service.setRunbookStatus({
        actorKind: "user",
        actorSessionId,
        actorUserId: userId,
        runbookId: request.params.runbookId,
        expectedVersion: parsed.value.expectedVersion,
        status: parsed.value.status,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      });

      return {
        ok: true,
        runbookId: result.snapshot.runbook.id,
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
      request.log.error({ err }, "Runbook status update failed");
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

  fastify.post<{
    Params: RunbookItemStatusRouteParams;
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
      const actor = {
        actorKind: "user" as const,
        actorSessionId,
        actorUserId: userId,
      };
      const isPageChecklistMutation = isPageChecklistStatusMutation(
        snapshot.runbook.id,
        item.id,
        parsed.value.status,
      );
      if (isPageChecklistMutation && !config.checklistAdapter) {
        throw new Error("page checklist adapter is not configured");
      }
      const checklistMutation = isPageChecklistMutation
        ? await config.checklistAdapter!.setChecked({
            runbookId: snapshot.runbook.id,
            itemId: item.id,
            checked: parsed.value.status === "completed",
            expectedVersion: parsed.value.expectedVersion,
            actor,
            reason: parsed.value.reason,
            idempotencyKey: parsed.value.idempotencyKey,
          })
        : null;
      const result = checklistMutation?.mutation ?? await config.service.setItemStatus({
        ...actor,
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

function isPageChecklistStatusMutation(
  runbookId: string,
  itemId: string,
  status: MutableRunbookItemStatus,
): boolean {
  return runbookId.startsWith("page-runbook:")
    && itemId.startsWith("checklist:")
    && (status === "pending" || status === "completed");
}

function parseRunbookStatusBody(body: StatusRequestBody): {
  ok: true;
  value: {
    status: MutableRunbookStatus;
    expectedVersion: number;
    idempotencyKey: string;
    reason: string | null;
  };
} | { ok: false; error: string } {
  const status = readRunbookStatus(body.status);
  if (!status) {
    return { ok: false, error: "status must be open or completed" };
  }

  const rest = parseVersionedMutationBody(body);
  if (!rest.ok) return rest;

  return {
    ok: true,
    value: {
      status,
      ...rest.value,
    },
  };
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
    return { ok: false, error: "status must be pending, review, completed, or cancelled" };
  }

  const rest = parseVersionedMutationBody(body);
  if (!rest.ok) return rest;

  return {
    ok: true,
    value: {
      status,
      ...rest.value,
    },
  };
}

function parseVersionedMutationBody(body: StatusRequestBody): {
  ok: true;
  value: {
    expectedVersion: number;
    idempotencyKey: string;
    reason: string | null;
  };
} | { ok: false; error: string } {
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
      expectedVersion,
      idempotencyKey,
      reason,
    },
  };
}

function readRunbookStatus(value: unknown): MutableRunbookStatus | null {
  if (value === "open" || value === "completed") {
    return value;
  }
  return null;
}

function readMutableStatus(value: unknown): MutableRunbookItemStatus | null {
  if (
    value === "pending" ||
    value === "review" ||
    value === "completed" ||
    value === "cancelled"
  ) {
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

function resolveRunbookActorSessionId(runbook: RunbookRow): string | null {
  return runbook.completed_session_id ||
    runbook.created_session_id ||
    null;
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
