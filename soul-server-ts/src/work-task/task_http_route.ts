import type { FastifyInstance } from "fastify";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";
import type {
  TaskItemRow,
  TaskItemStatus,
  TaskRow,
  TaskSectionRow,
  TaskStatus,
} from "../db/session_db_types.js";
import type { ChecklistTaskAdapter } from "../page/checklist_task_adapter.js";

import { registerTaskCreateHttpRoute } from "./task_create_http_route.js";
import { registerTaskCrudHttpRoutes } from "./task_crud_http_route.js";
import { TaskVersionConflict } from "./task_models.js";
import { registerTaskLegacyHttpCompatibility } from "./task_legacy_http_compat.js";
import type { TaskService } from "./task_service.js";
import type { TaskIdentityHostClient } from "./task_identity_host_client.js";

export interface TaskHttpRouteConfig {
  service: TaskService;
  taskIdentityHost: TaskIdentityHostClient;
  checklistAdapter?: Pick<ChecklistTaskAdapter, "setChecked">;
  auth: BoardYjsAuthConfig;
}

type MutableTaskItemStatus = Extract<
  TaskItemStatus,
  "pending" | "review" | "completed" | "cancelled"
>;
type MutableTaskStatus = Extract<TaskStatus, "open" | "completed">;

interface TaskItemStatusRouteParams {
  taskId: string;
  itemId: string;
}

interface TaskStatusRouteParams {
  taskId: string;
}

interface StatusRequestBody {
  status?: unknown;
  expectedVersion?: unknown;
  expected_version?: unknown;
  idempotencyKey?: unknown;
  idempotency_key?: unknown;
  reason?: unknown;
}

export function registerTaskHttpRoutes(
  fastify: FastifyInstance,
  config: TaskHttpRouteConfig,
): void {
  registerTaskCreateHttpRoute(fastify, config);
  registerTaskCrudHttpRoutes(fastify, config);
  registerTaskLegacyHttpCompatibility(fastify);

  fastify.post<{
    Params: TaskStatusRouteParams;
    Body: StatusRequestBody;
  }>("/api/tasks/:taskId/status", async (request, reply) => {
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
    const parsed = parseTaskStatusBody(body);
    if (!parsed.ok) {
      return reply.status(422).send({
        detail: {
          error: {
            code: "INVALID_TASK_STATUS_REQUEST",
            message: parsed.error,
          },
        },
      });
    }

    const snapshot = await config.service.getTask(request.params.taskId);
    if (!snapshot) {
      return reply.status(404).send({
        detail: {
          error: {
            code: "TASK_NOT_FOUND",
            message: "Task not found",
          },
        },
      });
    }
    const actorSessionId = resolveTaskActorSessionId(snapshot.task);
    if (!actorSessionId) {
      return reply.status(422).send({
        detail: {
          error: {
            code: "TASK_HAS_NO_SESSION_PROVENANCE",
            message: "Task has no session provenance",
          },
        },
      });
    }

    try {
      const result = await config.service.setTaskStatus({
        actorKind: "user",
        actorSessionId,
        actorUserId: userId,
        taskId: request.params.taskId,
        expectedVersion: parsed.value.expectedVersion,
        status: parsed.value.status,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      });

      return {
        ok: true,
        taskId: result.snapshot.task.id,
        eventId: result.eventId,
        idempotent: Boolean(result.idempotent),
        operation: result.operation,
        snapshot: result.snapshot,
      };
    } catch (err) {
      if (err instanceof TaskVersionConflict) {
        return reply.status(409).send({
          detail: {
            error: {
              code: "TASK_VERSION_CONFLICT",
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
      request.log.error({ err }, "Task status update failed");
      return reply.status(500).send({
        detail: {
          error: {
            code: "TASK_STATUS_UPDATE_FAILED",
            message: err instanceof Error ? err.message : "Task status update failed",
          },
        },
      });
    }
  });

  fastify.post<{
    Params: TaskItemStatusRouteParams;
    Body: StatusRequestBody;
  }>("/api/tasks/:taskId/items/:itemId/status", async (request, reply) => {
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
            code: "INVALID_TASK_STATUS_REQUEST",
            message: parsed.error,
          },
        },
      });
    }

    const snapshot = await config.service.getTask(request.params.taskId);
    if (!snapshot) {
      return reply.status(404).send({
        detail: {
          error: {
            code: "TASK_NOT_FOUND",
            message: "Task not found",
          },
        },
      });
    }
    const item = snapshot.items.find((candidate) => candidate.id === request.params.itemId);
    if (!item) {
      return reply.status(404).send({
        detail: {
          error: {
            code: "TASK_ITEM_NOT_FOUND",
            message: "Task item not found",
          },
        },
      });
    }
    const section = snapshot.sections.find((candidate) => candidate.id === item.section_id) ?? null;
    const actorSessionId = resolveActorSessionId(snapshot.task, section, item);
    if (!actorSessionId) {
      return reply.status(422).send({
        detail: {
          error: {
            code: "TASK_ITEM_HAS_NO_SESSION_PROVENANCE",
            message: "Task item has no session provenance",
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
        snapshot.task.id,
        item.id,
        parsed.value.status,
      );
      if (isPageChecklistMutation && !config.checklistAdapter) {
        throw new Error("page checklist adapter is not configured");
      }
      const checklistMutation = isPageChecklistMutation
        ? await config.checklistAdapter!.setChecked({
            taskId: snapshot.task.id,
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
        taskId: result.snapshot.task.id,
        itemId: request.params.itemId,
        eventId: result.eventId,
        idempotent: Boolean(result.idempotent),
        operation: result.operation,
        snapshot: result.snapshot,
      };
    } catch (err) {
      if (err instanceof TaskVersionConflict) {
        return reply.status(409).send({
          detail: {
            error: {
              code: "TASK_VERSION_CONFLICT",
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
      request.log.error({ err }, "Task item status update failed");
      return reply.status(500).send({
        detail: {
          error: {
            code: "TASK_STATUS_UPDATE_FAILED",
            message: err instanceof Error ? err.message : "Task status update failed",
          },
        },
      });
    }
  });
}

function isPageChecklistStatusMutation(
  _taskId: string,
  itemId: string,
  status: MutableTaskItemStatus,
): boolean {
  return itemId.startsWith("checklist:")
    && (status === "pending" || status === "completed");
}

function parseTaskStatusBody(body: StatusRequestBody): {
  ok: true;
  value: {
    status: MutableTaskStatus;
    expectedVersion: number;
    idempotencyKey: string;
    reason: string | null;
  };
} | { ok: false; error: string } {
  const status = readTaskStatus(body.status);
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
    status: MutableTaskItemStatus;
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

function readTaskStatus(value: unknown): MutableTaskStatus | null {
  if (value === "open" || value === "completed") {
    return value;
  }
  return null;
}

function readMutableStatus(value: unknown): MutableTaskItemStatus | null {
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

function resolveTaskActorSessionId(task: TaskRow): string | null {
  return task.completed_session_id ||
    task.created_session_id ||
    null;
}

function resolveActorSessionId(
  task: TaskRow,
  section: TaskSectionRow | null,
  item: TaskItemRow,
): string | null {
  return item.assignee_session_id ||
    item.updated_session_id ||
    item.created_session_id ||
    section?.updated_session_id ||
    section?.created_session_id ||
    task.created_session_id ||
    null;
}
