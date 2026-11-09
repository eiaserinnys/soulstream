import type { FastifyInstance, FastifyReply } from "fastify";

import {
  NodePairingError,
  type NodePairingPollResult,
  type NodePairingStarted,
} from "./pairing_service.js";

export type NodePairingRouteService = {
  start(input: unknown): Promise<NodePairingStarted>;
  poll(deviceCode: unknown): Promise<NodePairingPollResult>;
};

export type NodePairingRouteOptions = {
  service: NodePairingRouteService;
};

// A device pairs before it holds any credential, so these routes are public.
// They are safe to expose alone: the poll only hands a token to whoever holds
// the unguessable device_code created by start.
export const nodePairingRouteAuthRequirements = {
  "POST /api/node-pair/start": false,
  "POST /api/node-pair/poll": false,
} as const;

export function registerNodePairingRoutes(
  app: FastifyInstance,
  options: NodePairingRouteOptions,
): void {
  app.post("/api/node-pair/start", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    try {
      return await options.service.start({
        node_id: body.node_id,
        company_pc: body.company_pc,
      });
    } catch (error) {
      return sendPairingError(reply, error);
    }
  });

  app.post("/api/node-pair/poll", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    try {
      return await options.service.poll(body.device_code);
    } catch (error) {
      return sendPairingError(reply, error);
    }
  });
}

function sendPairingError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof NodePairingError)) throw error;
  const statusCode = {
    invalid_input: 400,
    not_found: 404,
    limit: 429,
    conflict: 409,
  }[error.code];
  return reply.code(statusCode).send({
    error: error.message,
    ...(error.conflictReason === undefined ? {} : { reason: error.conflictReason }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
