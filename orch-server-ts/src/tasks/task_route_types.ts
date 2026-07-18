import type { FastifyRequest } from "fastify";

import type {
  BoardAccess,
  BoardAccessFolderRecord,
} from "../board/board_access.js";
import type { TaskIdentityService } from "./task_identity_service.js";

export type TaskFolderRecord = BoardAccessFolderRecord & {
  [key: string]: unknown;
};

export type TaskOverview = {
  my_turn_items?: unknown;
  tasks?: unknown;
  [key: string]: unknown;
};

export type TaskSnapshot = {
  task?: Record<string, unknown> | null;
  sections?: unknown;
  items?: unknown;
  [key: string]: unknown;
};

export type TaskMutationNode = {
  nodeId: string;
  host: string;
  port: number;
  [key: string]: unknown;
};

export type TaskMutationHttpRequest = {
  method: "POST";
  url: string;
  upstreamPath: string;
  headers: Record<string, string>;
  body: unknown;
  target: TaskMutationNode;
};

export type TaskMutationHttpResponse = {
  statusCode: number;
  headers?: Record<string, string | undefined>;
  body?: unknown;
};

export type TaskMutationHttpClient = (
  request: TaskMutationHttpRequest,
) => Promise<TaskMutationHttpResponse>;

export type TaskRouteProvider = {
  listFolders: () => Promise<readonly TaskFolderRecord[]> | readonly TaskFolderRecord[];
  getTaskOverview?: (
    input: { userId: string | null; limit: number },
  ) => Promise<TaskOverview> | TaskOverview;
  getTaskSnapshot?: (
    taskId: string,
  ) => Promise<TaskSnapshot | undefined | null> | TaskSnapshot | undefined | null;
  findSessionNode?: (
    actorSessionId: string,
  ) =>
    | Promise<TaskMutationNode | undefined | null>
    | TaskMutationNode
    | undefined
    | null;
  listConnectedNodes?: () => readonly TaskMutationNode[];
};

export type TaskAccess = BoardAccess;

export type TaskAccessProvider = {
  resolveAccess: (request: FastifyRequest) => Promise<TaskAccess> | TaskAccess;
};

export type TaskRouteOptions = {
  provider: TaskRouteProvider;
  accessProvider: TaskAccessProvider;
  httpClient: TaskMutationHttpClient;
  resolveDashboardUserId?: (
    request: FastifyRequest,
  ) => Promise<string | null> | string | null;
  taskIdentityService?: Pick<
    TaskIdentityService,
    "create" | "promoteExistingPage" | "mutateFromTask" | "backfillLegacyTask"
  >;
  authBearerToken?: string;
};

export class TaskRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "TaskRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const taskRouteAuthRequirements = {
  "POST /api/tasks": true,
  "GET /api/tasks/my-turn": true,
  "POST /api/tasks/:task_id/items/:item_id/status": true,
  "POST /api/tasks/:task_id/status": true,
  "POST /api/tasks/:task_id/sections": true,
  "POST /api/tasks/:task_id/sections/:section_id": true,
  "POST /api/tasks/:task_id/sections/:section_id/move": true,
  "POST /api/tasks/:task_id/sections/:section_id/archive": true,
  "POST /api/tasks/:task_id/sections/:section_id/items": true,
  "POST /api/tasks/:task_id/items/:item_id": true,
  "POST /api/tasks/:task_id/items/:item_id/move": true,
  "POST /api/tasks/:task_id/items/:item_id/archive": true,
  "GET /api/tasks/:task_id": true,
} as const;
