import type { FastifyInstance } from "fastify";

import type { InMemoryNodeRegistry, NodeRegistryEvent } from "./registry.js";
import type {
  NodeCommandTransport,
  NodeCommandTransportAttachment,
  NodeCommandTransportHub,
} from "./transport_hub.js";
import { verifyNodeWsBearer } from "./ws_auth.js";
import { NODE_ID_MISMATCH_REJECT_REASON } from "./ws_frame_controller.js";
import type {
  NodeCredentialResolver,
  NodePrincipal,
} from "../node_credentials/types.js";
import {
  NODE_CREDENTIAL_REVOKED_CLOSE_CODE,
  NODE_CREDENTIAL_REVOKED_REASON,
} from "../node_credentials/revocation.js";

const INVALID_JSON_CLOSE_CODE = 1003;
const POLICY_VIOLATION_CLOSE_CODE = 1008;
const REGISTRATION_TIMEOUT_CLOSE_CODE = 4001;
const INTERNAL_ERROR_CLOSE_CODE = 1011;
const DEFAULT_CONTROL_PING_INTERVAL_MS = 15_000;
const DEFAULT_CONTROL_PING_MISS_LIMIT = 2;

export function registerNodeControlWsRoute(
  app: FastifyInstance,
  options: {
    registry: InMemoryNodeRegistry;
    nodeCredentials: NodeCredentialResolver | null;
    transportHub?: NodeCommandTransportHub;
    eventSink?: (events: NodeRegistryEvent[]) => void;
    controlPingIntervalMs?: number;
    controlPingMissLimit?: number;
  },
  security: { environment: string; authBearerToken: string },
  registrationTimeoutMs: number,
): void {
  const controlPingIntervalMs = resolveControlPingIntervalMs(
    options.controlPingIntervalMs,
  );
  const controlPingMissLimit = resolveControlPingMissLimit(
    options.controlPingMissLimit,
  );
  // The principal resolved in preValidation rides the same Fastify request
  // object into the websocket handler; the value never leaves this route.
  const principalByRequest = new WeakMap<object, NodePrincipal | null>();
  const connectionsByCredential = new Map<string, Set<() => void>>();
  const unsubscribeRevocations = options.nodeCredentials?.onRevoked((principal) => {
    const closers = connectionsByCredential.get(principal.credential_id);
    if (closers === undefined) return;
    for (const close of Array.from(closers)) close();
  }) ?? undefined;
  if (unsubscribeRevocations !== undefined) {
    app.addHook("onClose", async () => {
      unsubscribeRevocations();
    });
  }
  app.get("/ws/node/control", {
    websocket: true,
    preValidation: async (request, reply) => {
      const auth = verifyNodeWsBearer({
        environment: security.environment,
        configuredToken: security.authBearerToken,
        nodeCredentials: options.nodeCredentials,
        authorization: request.headers.authorization,
      });
      if (!auth.ok) {
        return reply.code(auth.statusCode).send({ detail: auth.detail });
      }
      principalByRequest.set(request, auth.principal ?? null);
    },
  }, (socket, request) => {
    const principal = principalByRequest.get(request) ?? null;
    const transport: NodeCommandTransport = {
      send: (data) => socket.send(data),
    };
    let source: { nodeId: string; connectionId: string } | undefined;
    let attachment: NodeCommandTransportAttachment | undefined;
    let finalized = false;
    let registrationTimer: ReturnType<typeof setTimeout> | undefined;
    let unregisterRevocation: (() => void) | undefined;
    let missedPongs = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const clearPingTimer = (): void => {
      if (pingTimer === undefined) return;
      clearInterval(pingTimer);
      pingTimer = undefined;
    };

    const finalize = (reason: string): void => {
      if (finalized) return;
      finalized = true;
      if (registrationTimer !== undefined) clearTimeout(registrationTimer);
      clearPingTimer();
      if (options.transportHub && attachment) {
        options.transportHub.detach(attachment);
      }
      attachment = undefined;
      unregisterRevocation?.();
      unregisterRevocation = undefined;
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
    /**
     * A half-open TCP connection never delivers a close handshake. Detach the
     * control lane first so the next command falls back to the data lane, then
     * drop the socket without waiting for the peer to answer a close frame.
     */
    const terminateAndFinalize = (reason: string): void => {
      clearPingTimer();
      try {
        socket.terminate();
      } catch {
        // Canonical attachment cleanup still runs below.
      }
      finalize(reason);
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

    if (principal !== null) {
      const credentialId = principal.credential_id;
      const closers = connectionsByCredential.get(credentialId)
        ?? new Set<() => void>();
      connectionsByCredential.set(credentialId, closers);
      const closeForRevocation = (): void => {
        closeAndFinalize(
          NODE_CREDENTIAL_REVOKED_CLOSE_CODE,
          NODE_CREDENTIAL_REVOKED_REASON,
        );
      };
      closers.add(closeForRevocation);
      unregisterRevocation = () => {
        closers.delete(closeForRevocation);
        if (closers.size === 0) connectionsByCredential.delete(credentialId);
      };
    }

    // Every control socket, regardless of the node's capabilities or version,
    // gets protocol pings: a half-open control lane otherwise blackholes
    // commands until the OS TCP retransmission limit. A pong proves the peer
    // is still there; two intervals without one drop the lane.
    socket.on("pong", () => {
      missedPongs = 0;
    });
    pingTimer = setInterval(() => {
      if (finalized) {
        clearPingTimer();
        return;
      }
      if (missedPongs >= controlPingMissLimit) {
        terminateAndFinalize("control ping timeout");
        return;
      }
      missedPongs += 1;
      try {
        socket.ping();
      } catch {
        // A broken socket surfaces through its close event.
      }
    }, controlPingIntervalMs);

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
        if (principal !== null && frame.node_id !== principal.node_id) {
          closeAndFinalize(
            POLICY_VIOLATION_CLOSE_CODE,
            NODE_ID_MISMATCH_REJECT_REASON,
          );
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

function resolveControlPingIntervalMs(value: number | undefined): number {
  const intervalMs = value ?? DEFAULT_CONTROL_PING_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`controlPingIntervalMs must be a positive integer: ${intervalMs}`);
  }
  return intervalMs;
}

function resolveControlPingMissLimit(value: number | undefined): number {
  const missLimit = value ?? DEFAULT_CONTROL_PING_MISS_LIMIT;
  if (!Number.isInteger(missLimit) || missLimit <= 0) {
    throw new Error(`controlPingMissLimit must be a positive integer: ${missLimit}`);
  }
  return missLimit;
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
