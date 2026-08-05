import type { FastifyInstance, FastifyReply } from "fastify";

import {
  handleBoardYjsHostOperation,
  type BoardYjsHostOperationOptions,
} from "../board-yjs/board_yjs_host_operations.js";
import type { BoardYjsService } from "../board-yjs/board_yjs_service.js";

export type BoardYjsHostProxyRouteOptions = {
  authBearerToken: string;
  service?: BoardYjsService;
  createService?: (logger: FastifyInstance["log"]) => BoardYjsService;
};

const localBoardYjsServices = new WeakMap<
  BoardYjsHostProxyRouteOptions,
  BoardYjsService
>();

export const boardYjsHostProxyRouteAuthRequirements = {
  "POST /api/board-yjs/host/{operation}": true,
} as const;

export function registerBoardYjsHostProxyRoutes(
  app: FastifyInstance,
  options: BoardYjsHostProxyRouteOptions,
): void {
  app.post<{ Params: { operation: string } }>(
    "/api/board-yjs/host/:operation",
    async (request, reply) => await handleBoardYjsHostOperation(
      request,
      reply,
      request.params.operation,
      resolveLocalOperationOptions(app, options),
    ),
  );
}

function resolveLocalOperationOptions(
  app: FastifyInstance,
  options: BoardYjsHostProxyRouteOptions,
): BoardYjsHostOperationOptions {
  return {
    service: resolveLocalBoardYjsService(app, options),
    authBearerToken: options.authBearerToken,
  };
}

export function resolveLocalBoardYjsService(
  app: FastifyInstance,
  options: BoardYjsHostProxyRouteOptions,
): BoardYjsService {
  const existing = options.service ?? localBoardYjsServices.get(options);
  if (existing !== undefined) return existing;
  const created = options.createService?.(app.log);
  if (created === undefined) {
    throw new Error("Orchestrator Board Yjs service is required");
  }
  localBoardYjsServices.set(options, created);
  return created;
}

export function sendBoardYjsHostProxyError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  return reply.code(500).send({
    error: {
      code: "BOARD_YJS_HOST_OPERATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}
