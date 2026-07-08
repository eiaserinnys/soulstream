import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

import { NodeWsFrameController } from "./ws_frame_controller.js";
import type { InMemoryNodeRegistry } from "./registry.js";
import type {
  NodeCommandTransport,
  NodeCommandTransportAttachment,
  NodeCommandTransportHub,
} from "./transport_hub.js";

const INVALID_JSON_CLOSE_CODE = 1003;
const POLICY_VIOLATION_CLOSE_CODE = 1008;

export type NodeWsRouteOptions = {
  registry: InMemoryNodeRegistry;
  transportHub?: NodeCommandTransportHub;
};

export function registerNodeWsRoute(
  app: FastifyInstance,
  options: NodeWsRouteOptions,
): void {
  app.register(websocket);
  app.after(() => {
    app.get("/ws/node", { websocket: true }, (socket) => {
      const controller = new NodeWsFrameController({ registry: options.registry });
      const transport: NodeCommandTransport = {
        send: (data) => socket.send(data),
      };
      let attachment: NodeCommandTransportAttachment | undefined;

      socket.on("message", (payload) => {
        const parsed = parseJsonFrame(payload);
        if (!parsed.ok) {
          socket.close(parsed.closeCode, parsed.reason);
          return;
        }

        const result = controller.handleFrame(parsed.frame);
        if (result.type === "registered" && options.transportHub !== undefined) {
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
        }
        if (result.type === "registration_rejected") {
          socket.close(POLICY_VIOLATION_CLOSE_CODE, result.code);
        }
      });

      socket.on("close", () => {
        detachTransport(options.transportHub, attachment);
        attachment = undefined;
        controller.close("websocket_close");
      });
      socket.on("error", () => {
        detachTransport(options.transportHub, attachment);
        attachment = undefined;
        controller.close("websocket_error");
      });
    });
  });
}

function detachTransport(
  transportHub: NodeCommandTransportHub | undefined,
  attachment: NodeCommandTransportAttachment | undefined,
): void {
  if (transportHub === undefined || attachment === undefined) return;
  transportHub.detach(attachment);
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
