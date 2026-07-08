import type { FastifyRequest } from "fastify";

import type {
  BoardAccess,
  BoardAccessFolderRecord,
} from "../board/board_access.js";

export type RunbookFolderRecord = BoardAccessFolderRecord & {
  [key: string]: unknown;
};

export type RunbookOverview = {
  my_turn_items?: unknown;
  runbooks?: unknown;
  [key: string]: unknown;
};

export type RunbookSnapshot = {
  runbook?: Record<string, unknown> | null;
  sections?: unknown;
  items?: unknown;
  [key: string]: unknown;
};

export type RunbookMutationNode = {
  nodeId: string;
  host: string;
  port: number;
  [key: string]: unknown;
};

export type RunbookMutationHttpRequest = {
  method: "POST";
  url: string;
  upstreamPath: string;
  headers: Record<string, string>;
  body: unknown;
  target: RunbookMutationNode;
};

export type RunbookMutationHttpResponse = {
  statusCode: number;
  headers?: Record<string, string | undefined>;
  body?: unknown;
};

export type RunbookMutationHttpClient = (
  request: RunbookMutationHttpRequest,
) => Promise<RunbookMutationHttpResponse>;

export type RunbookRouteProvider = {
  listFolders: () => Promise<readonly RunbookFolderRecord[]> | readonly RunbookFolderRecord[];
  getRunbookOverview?: (
    input: { userId: string | null; limit: number },
  ) => Promise<RunbookOverview> | RunbookOverview;
  getRunbookSnapshot?: (
    runbookId: string,
  ) => Promise<RunbookSnapshot | undefined | null> | RunbookSnapshot | undefined | null;
  findSessionNode?: (
    actorSessionId: string,
  ) =>
    | Promise<RunbookMutationNode | undefined | null>
    | RunbookMutationNode
    | undefined
    | null;
  listConnectedNodes?: () => readonly RunbookMutationNode[];
};

export type RunbookAccess = BoardAccess;

export type RunbookAccessProvider = {
  resolveAccess: (request: FastifyRequest) => Promise<RunbookAccess> | RunbookAccess;
};

export type RunbookRouteOptions = {
  provider: RunbookRouteProvider;
  accessProvider: RunbookAccessProvider;
  httpClient: RunbookMutationHttpClient;
  resolveDashboardUserId?: (
    request: FastifyRequest,
  ) => Promise<string | null> | string | null;
};

export class RunbookRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "RunbookRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const runbookRouteAuthRequirements = {
  "GET /api/runbooks/my-turn": true,
  "POST /api/runbooks/:runbook_id/items/:item_id/status": true,
  "POST /api/runbooks/:runbook_id/status": true,
  "GET /api/runbooks/:runbook_id": true,
} as const;
