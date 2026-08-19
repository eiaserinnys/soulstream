import type { FastifyInstance } from "fastify";

import type { InMemoryNodeRegistry, NodeRegistryEvent } from "./registry.js";
import type {
  NodeCommandTransport,
  NodeCommandTransportAttachment,
  NodeCommandTransportHub,
} from "./transport_hub.js";
import { verifyNodeWsBearer } from "./ws_auth.js";

const INVALID_JSON_CLOSE_CODE = 1003;
const POLICY_VIOLATION_CLOSE_CODE = 1008;
const REGISTRATION_TIMEOUT_CLOSE_CODE = 4001;
const INTERNAL_ERROR_CLOSE_CODE = 1011;

export function registerNodeControlWsRoute(
  app: FastifyInstance,
  options: {
    registry: InMemoryNodeRegistry;
    transportHub?: NodeCommandTransportHub;
    eventSink?: (events: NodeRegistryEvent[]) => void;
  },
  security: { environment: string; authBearerToken: string },
  registrationTimeoutMs: number,
): void {
  app.get("/ws/node/control", {
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
    const transport: NodeCommandTransport = {
      send: (data) => socket.send(data),
    };
    let source: { nodeId: string; connectionId: string } | undefined;
    let attachment: NodeCommandTransportAttachment | undefined;
    let finalized = false;
    let registrationTimer: ReturnType<typeof setTimeout> | undefined;

    const finalize = (reason: string): void => {
      if (finalized) return;
      finalized = true;
      if (registrationTimer !== undefined) clearTimeout(registrationTimer);
      if (options.transportHub && attachment) {
        options.transportHub.detach(attachment);
      }
      attachment = undefined;
      app.log.info({
        nodeId: source?.nodeId,
        connectionId: source?.connectionId,
        path: "/ws/node/control",
        reason,
      }, "Node control WebSocket disconnected");
    };
    const closeAndFinalize = (code: number, reason: string): void => {
      try {
        socket.close(code, reason);
      } catch {
        // Canonical attachment cleanup still runs below.
      } finally {
        finalize(reason);
      }
    };
    const send = (frame: Record<string, unknown>): boolean => {
      try {
        socket.send(JSON.stringify(frame));
        return true;
      } catch {
        closeAndFinalize(INTERNAL_ERROR_CLOSE_CODE, "websocket send failed");
        return false;
      }
    };
    const isCurrentSource = (): boolean => source !== undefined
      && options.registry.getConnectedNode(source.nodeId)?.connectionId
        === source.connectionId;

    registrationTimer = setTimeout(() => {
      closeAndFinalize(
        REGISTRATION_TIMEOUT_CLOSE_CODE,
        "control registration timeout",
      );
    }, registrationTimeoutMs);

    socket.on("message", (payload) => {
      if (finalized) return;
      const parsed = parseJsonFrame(payload);
      if (!parsed.ok) {
        closeAndFinalize(parsed.closeCode, parsed.reason);
        return;
      }
      const frame = parsed.frame;

      if (source === undefined) {
        if (
          frame.type !== "node_control_register"
          || typeof frame.node_id !== "string"
          || typeof frame.connection_id !== "string"
        ) {
          closeAndFinalize(POLICY_VIOLATION_CLOSE_CODE, "EXPECTED_NODE_CONTROL_REGISTER");
          return;
        }
        const current = options.registry.getConnectedNode(frame.node_id);
        if (
          current?.connectionId !== frame.connection_id
          || current.capabilities.control_channel_v1 !== true
        ) {
          closeAndFinalize(POLICY_VIOLATION_CLOSE_CODE, "STALE_NODE_CONNECTION");
          return;
        }
        source = { nodeId: frame.node_id, connectionId: frame.connection_id };
        if (registrationTimer !== undefined) {
          clearTimeout(registrationTimer);
          registrationTimer = undefined;
        }
        send({
          type: "node_control_register_ack",
          node_id: source.nodeId,
          connection_id: source.connectionId,
        });
        return;
      }

      if (!isCurrentSource()) {
        closeAndFinalize(POLICY_VIOLATION_CLOSE_CODE, "STALE_NODE_CONNECTION");
        return;
      }
      if (frame.type === "node_control_ready") {
        if (options.transportHub !== undefined && attachment === undefined) {
          attachment = { ...source, lane: "control", transport };
          options.transportHub.attach(attachment);
        }
        send({ type: "node_control_ready_ack" });
        return;
      }
      if (frame.type === "control_result") {
        if (!isValidControlResult(frame, source)) {
          closeAndFinalize(POLICY_VIOLATION_CLOSE_CODE, "INVALID_CONTROL_RESULT");
          return;
        }
        emitEvents(
          options.eventSink,
          options.registry.receiveNodeMessage(source, frame.response),
        );
        send({ type: "control_result_ack", resultId: frame.resultId });
        return;
      }
      if (frame.type === "control_ack_metric") {
        if (frame.nodeId !== source.nodeId) {
          closeAndFinalize(POLICY_VIOLATION_CLOSE_CODE, "STALE_CONTROL_METRIC");
          return;
        }
        options.registry.receiveNodeMessage(source, frame);
        return;
      }
      if (typeof frame.requestId === "string" && frame.requestId.length > 0) {
        emitEvents(
          options.eventSink,
          options.registry.receiveNodeMessage(source, frame),
        );
        return;
      }
      closeAndFinalize(POLICY_VIOLATION_CLOSE_CODE, "UNSUPPORTED_CONTROL_FRAME");
    });
    socket.on("close", () => finalize("websocket_close"));
    socket.on("error", () => closeAndFinalize(
      INTERNAL_ERROR_CLOSE_CODE,
      "websocket error",
    ));
  });
}

type JsonFrameParseResult =
  | { ok: true; frame: Record<string, unknown> }
  | { ok: false; closeCode: number; reason: string };

function parseJsonFrame(payload: unknown): JsonFrameParseResult {
  const text = payloadToText(payload);
  if (text === undefined) {
    return { ok: false, closeCode: INVALID_JSON_CLOSE_CODE, reason: "unsupported websocket payload" };
  }
  try {
    const decoded = JSON.parse(text) as unknown;
    return isRecord(decoded)
      ? { ok: true, frame: decoded }
      : { ok: false, closeCode: INVALID_JSON_CLOSE_CODE, reason: "unsupported JSON frame" };
  } catch {
    return { ok: false, closeCode: INVALID_JSON_CLOSE_CODE, reason: "invalid JSON frame" };
  }
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

function emitEvents(
  sink: ((events: NodeRegistryEvent[]) => void) | undefined,
  events: NodeRegistryEvent[],
): void {
  if (!sink || events.length === 0) return;
  try {
    sink(events);
  } catch {
    // Event broadcasting is ride-along work; control settlement stays canonical.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidControlResult(
  frame: Record<string, unknown>,
  source: { nodeId: string; connectionId: string },
): frame is Record<string, unknown> & {
  resultId: string;
  response: Record<string, unknown>;
} {
  if (
    typeof frame.resultId !== "string"
    || frame.nodeId !== source.nodeId
    || typeof frame.commandFamily !== "string"
    || typeof frame.requestId !== "string"
    || (frame.state !== "completed" && frame.state !== "rejected")
    || !isRecord(frame.response)
  ) return false;
  return frame.response.requestId === frame.requestId
    && typeof frame.response.type === "string";
}
