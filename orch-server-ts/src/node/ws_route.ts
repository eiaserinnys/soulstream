import type { FastifyInstance } from "fastify";

import {
  NodeWsFrameController,
  type NodeWsFrameCloseResult,
  type NodeWsFrameControllerResult,
} from "./ws_frame_controller.js";
import type { InMemoryNodeRegistry } from "./registry.js";
import type { NodeRegistryEvent } from "./registry.js";
import type {
  NodeCommandTransport,
  NodeCommandTransportAttachment,
  NodeCommandTransportHub,
} from "./transport_hub.js";
import { verifyNodeWsBearer } from "./ws_auth.js";
import { registerWebsocketPlugin } from "../websocket_plugin.js";

const INVALID_JSON_CLOSE_CODE = 1003;
const POLICY_VIOLATION_CLOSE_CODE = 1008;
const REGISTRATION_TIMEOUT_CLOSE_CODE = 4001;
const INTERNAL_ERROR_CLOSE_CODE = 1011;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000;

export type NodeWsRouteOptions = {
  registry: InMemoryNodeRegistry;
  transportHub?: NodeCommandTransportHub;
  eventSink?: NodeRegistryEventSink;
  registrationTimeoutMs?: number;
};

export type NodeWsRouteSecurity = {
  environment: string;
  authBearerToken: string;
};

export type NodeRegistryEventSink = (events: NodeRegistryEvent[]) => void;

export const nodeWsRouteAuthRequirements = {
  "WEBSOCKET /ws/node": false,
} as const;

export function registerNodeWsRoute(
  app: FastifyInstance,
  options: NodeWsRouteOptions,
  security: NodeWsRouteSecurity,
): void {
  const registrationTimeoutMs = resolveRegistrationTimeoutMs(
    options.registrationTimeoutMs,
  );
  registerWebsocketPlugin(app);
  app.after(() => {
    app.get("/ws/node", {
      websocket: true,
      preValidation: async (request, reply) => {
        const auth = verifyNodeWsBearer({
          environment: security.environment,
          configuredToken: security.authBearerToken,
          authorization: request.headers.authorization,
        });
        if (!auth.ok) {
          return reply.code(auth.statusCode).send({ detail: auth.detail });
        }
      },
    }, (socket, _request) => {
      const controller = new NodeWsFrameController({ registry: options.registry });
      const transport: NodeCommandTransport = {
        send: (data) => socket.send(data),
      };
      let attachment: NodeCommandTransportAttachment | undefined;
      let finalized = false;
      let registrationTimer: ReturnType<typeof setTimeout> | undefined;

      app.log.info({
        path: "/ws/node",
      }, "Node WebSocket connected");

      const finalize = (reason: string): void => {
        if (finalized) return;
        finalized = true;
        clearRegistrationTimer();
        app.log.info({
          nodeId: attachment?.nodeId,
          path: "/ws/node",
          reason,
        }, "Node WebSocket disconnected");
        detachTransport(options.transportHub, attachment);
        attachment = undefined;
        emitEvents(
          options.eventSink,
          eventsFromControllerCloseResult(controller.close(reason)),
        );
      };
      const closeAndFinalize = (
        code: number,
        reason: string,
        cleanupReason = reason,
      ): void => {
        try {
          socket.close(code, reason);
        } catch {
          // The socket may already be broken; canonical cleanup still runs below.
        } finally {
          finalize(cleanupReason);
        }
      };
      const clearRegistrationTimer = (): void => {
        if (registrationTimer === undefined) return;
        clearTimeout(registrationTimer);
        registrationTimer = undefined;
      };

      registrationTimer = setTimeout(() => {
        closeAndFinalize(
          REGISTRATION_TIMEOUT_CLOSE_CODE,
          "registration timeout",
          "registration_timeout",
        );
      }, registrationTimeoutMs);

      socket.on("message", (payload) => {
        if (finalized) return;
        const parsed = parseJsonFrame(payload);
        if (!parsed.ok) {
          closeAndFinalize(parsed.closeCode, parsed.reason);
          return;
        }

        const result = controller.handleFrame(parsed.frame);
        if (result.type === "registered" && options.transportHub !== undefined) {
          clearRegistrationTimer();
          for (const event of result.events) {
            if (event.type === "node_unregistered") {
              options.transportHub.detach({
                nodeId: event.nodeId,
                connectionId: event.connectionId,
              });
            }
          }

          attachment = {
            nodeId: result.nodeId,
            connectionId: result.connectionId,
            transport,
          };
          options.transportHub.attach(attachment);
        } else if (result.type === "registered") {
          clearRegistrationTimer();
        }
        if (result.type === "registration_rejected") {
          closeAndFinalize(POLICY_VIOLATION_CLOSE_CODE, result.code);
          return;
        }
        emitEvents(options.eventSink, eventsFromControllerResult(result));

        if (result.type === "message" && result.outboundFrames !== undefined) {
          try {
            for (const frame of result.outboundFrames) {
              socket.send(JSON.stringify(frame));
            }
          } catch {
            closeAndFinalize(
              INTERNAL_ERROR_CLOSE_CODE,
              "websocket send failed",
              "websocket_send_error",
            );
          }
        }
      });

      socket.on("close", () => {
        finalize("websocket_close");
      });
      socket.on("error", () => {
        closeAndFinalize(
          INTERNAL_ERROR_CLOSE_CODE,
          "websocket error",
          "websocket_error",
        );
      });
    });
  });
}

function resolveRegistrationTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`registrationTimeoutMs must be a positive integer: ${timeoutMs}`);
  }
  return timeoutMs;
}

function detachTransport(
  transportHub: NodeCommandTransportHub | undefined,
  attachment: NodeCommandTransportAttachment | undefined,
): void {
  if (transportHub === undefined || attachment === undefined) return;
  transportHub.detach(attachment);
}

function eventsFromControllerResult(
  result: NodeWsFrameControllerResult,
): NodeRegistryEvent[] {
  return "events" in result ? result.events : [];
}

function eventsFromControllerCloseResult(
  result: NodeWsFrameCloseResult,
): NodeRegistryEvent[] {
  return result.type === "closed" ? [result.event] : [];
}

function emitEvents(
  eventSink: NodeRegistryEventSink | undefined,
  events: NodeRegistryEvent[],
): void {
  if (eventSink === undefined || events.length === 0) return;
  try {
    eventSink(events);
  } catch {
    // Event broadcasting is ride-along work; node websocket state stays canonical.
  }
}

type JsonFrameParseResult =
  | {
      ok: true;
      frame: Record<string, unknown>;
    }
  | {
      ok: false;
      closeCode: number;
      reason: string;
    };

function parseJsonFrame(payload: unknown): JsonFrameParseResult {
  const text = payloadToText(payload);
  if (text === undefined) {
    return {
      ok: false,
      closeCode: INVALID_JSON_CLOSE_CODE,
      reason: "unsupported websocket payload",
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return {
      ok: false,
      closeCode: INVALID_JSON_CLOSE_CODE,
      reason: "invalid JSON frame",
    };
  }

  if (!isRecord(decoded)) {
    return {
      ok: false,
      closeCode: INVALID_JSON_CLOSE_CODE,
      reason: "unsupported JSON frame",
    };
  }
  return { ok: true, frame: decoded };
}

function payloadToText(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload;
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString("utf8");
  if (Array.isArray(payload) && payload.every(Buffer.isBuffer)) {
    return Buffer.concat(payload).toString("utf8");
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
