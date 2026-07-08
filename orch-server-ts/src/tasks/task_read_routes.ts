import type { FastifyInstance, FastifyReply } from "fastify";

export const TASK_CONTEXT_SESSION_ID_REQUIRED_DETAIL =
  "sessionId query parameter is required";
export const TASK_INVALID_STATUS_DETAIL = "Invalid task status";
export const TASK_INCLUDE_ARCHIVED_BOOLEAN_DETAIL = "includeArchived must be a boolean";
export const TASK_LIMIT_RANGE_DETAIL = "limit must be between 1 and 1000";

export type TaskStatus =
  | "open"
  | "in_progress"
  | "agent_done"
  | "verified_done"
  | "reopened"
  | "blocked"
  | "cancelled";

export type TaskReadListQuery = {
  query?: string;
  status?: TaskStatus;
  rootTaskId?: string;
  linkedSessionId?: string;
  includeArchived: boolean;
  limit: number;
};

export type SerializedTaskItem = {
  id: string;
  parentId?: string | null;
  positionKey?: number | null;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  verificationOwner?: "agent" | "user" | "both";
  status: TaskStatus;
  linkedSessionId?: string | null;
  linkedNodeId?: string | null;
  activeForSessionId?: string | null;
  createdFromSessionId?: string | null;
  createdFromEventId?: number | null;
  navigationSessionId?: string | null;
  navigationNodeId?: string | null;
  navigationEventId?: number | null;
  archived?: boolean;
  pinned?: boolean;
  version?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  linkedSession?: unknown;
  [key: string]: unknown;
};

export type TaskReadContext = {
  activeTask: SerializedTaskItem | null;
  activeTaskPath: readonly SerializedTaskItem[];
  linkedTasks: readonly SerializedTaskItem[];
  [key: string]: unknown;
};

export type TaskReadRouteProvider = {
  listTasks: (
    query: TaskReadListQuery,
  ) => Promise<readonly SerializedTaskItem[]> | readonly SerializedTaskItem[];
  getTaskContext: (sessionId: string) => Promise<TaskReadContext> | TaskReadContext;
};

export type TaskReadRouteOptions = {
  provider: TaskReadRouteProvider;
};

export const taskReadRouteAuthRequirements = {
  "GET /api/tasks": true,
  "GET /api/tasks/context": true,
} as const;

const taskStatuses = new Set<TaskStatus>([
  "open",
  "in_progress",
  "agent_done",
  "verified_done",
  "reopened",
  "blocked",
  "cancelled",
]);

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; statusCode: number; detail: string };

export function registerTaskReadRoutes(
  app: FastifyInstance,
  options: TaskReadRouteOptions,
): void {
  app.get("/api/tasks", async (request, reply) => {
    const query = parseTaskListQuery(request.query);
    if (!query.ok) return routeError(reply, query.statusCode, query.detail);
    const tasks = await options.provider.listTasks(query.value);
    return reply.send({ tasks });
  });

  app.get("/api/tasks/context", async (request, reply) => {
    const sessionId = stringQuery(request.query, "sessionId");
    if (sessionId === undefined) {
      return routeError(reply, 422, TASK_CONTEXT_SESSION_ID_REQUIRED_DETAIL);
    }
    return reply.send(await options.provider.getTaskContext(sessionId));
  });
}

function parseTaskListQuery(query: unknown): Validation<TaskReadListQuery> {
  const status = parseTaskStatus(query);
  if (!status.ok) return status;
  const limit = parseLimit(query);
  if (!limit.ok) return limit;
  const includeArchived = parseIncludeArchived(query);
  if (!includeArchived.ok) return includeArchived;
  return {
    ok: true,
    value: {
      query: stringQuery(query, "query"),
      status: status.value,
      rootTaskId: stringQuery(query, "rootTaskId"),
      linkedSessionId: stringQuery(query, "linkedSessionId"),
      includeArchived: includeArchived.value,
      limit: limit.value,
    },
  };
}

function parseTaskStatus(query: unknown): Validation<TaskStatus | undefined> {
  const value = stringQuery(query, "status");
  if (value === undefined) return { ok: true, value: undefined };
  if (taskStatuses.has(value as TaskStatus)) {
    return { ok: true, value: value as TaskStatus };
  }
  return { ok: false, statusCode: 422, detail: TASK_INVALID_STATUS_DETAIL };
}

function parseLimit(query: unknown): Validation<number> {
  const raw = queryValue(query, "limit");
  if (raw === undefined || raw === "") return { ok: true, value: 500 };
  if (typeof raw !== "string") {
    return { ok: false, statusCode: 422, detail: TASK_LIMIT_RANGE_DETAIL };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 1000) {
    return { ok: false, statusCode: 422, detail: TASK_LIMIT_RANGE_DETAIL };
  }
  return { ok: true, value: parsed };
}

function parseIncludeArchived(query: unknown): Validation<boolean> {
  const value = parseBooleanQuery(query, "includeArchived");
  if (value === undefined) return { ok: true, value: false };
  if (value === "invalid") {
    return { ok: false, statusCode: 422, detail: TASK_INCLUDE_ARCHIVED_BOOLEAN_DETAIL };
  }
  return { ok: true, value };
}

function stringQuery(query: unknown, key: string): string | undefined {
  const value = queryValue(query, key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanQuery(query: unknown, key: string): boolean | "invalid" | undefined {
  const value = queryValue(query, key);
  if (typeof value !== "string") return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return "invalid";
}

function queryValue(query: unknown, key: string): unknown {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[key];
  return Array.isArray(value) ? value[0] : value;
}

function routeError(reply: FastifyReply, statusCode: number, detail: string): FastifyReply {
  return reply.code(statusCode).send({ detail });
}
