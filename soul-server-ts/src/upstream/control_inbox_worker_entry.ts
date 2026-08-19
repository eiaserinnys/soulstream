import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { WebSocket } from "ws";

import { ControlInboxRuntime } from "./control_inbox_runtime.js";
import { ControlInboxStore } from "./control_inbox_store.js";

type WorkerInput = {
  nodeId: string;
  upstreamUrl: string;
  authBearerToken: string;
  runnerStateDir: string;
  heartbeatBuffer: SharedArrayBuffer;
};

const input = workerData as WorkerInput;
const parent = requireParentPort();

const heartbeat = new BigInt64Array(input.heartbeatBuffer);
const store = new ControlInboxStore({
  databasePath: join(input.runnerStateDir, "_control", "control-inbox.sqlite"),
  nodeId: input.nodeId,
  hostGeneration: randomUUID(),
});
const runtime = new ControlInboxRuntime({
  store,
  nodeId: input.nodeId,
  mainHeartbeatAgeMs: () => {
    const lastHeartbeatAt = Number(Atomics.load(heartbeat, 0));
    return lastHeartbeatAt > 0 ? Math.max(0, Date.now() - lastHeartbeatAt) : Infinity;
  },
  postWork: (work) => parent.postMessage({ type: "control_work", work }),
  onDurableCommit: (workId) => {
    parent.postMessage({ type: "control_domain_committed", workId });
  },
});

let activeConnectionId: string | undefined;
let socket: WebSocket | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectAttempt = 0;
let stopping = false;

try {
  const stats = runtime.initialize();
  parent.postMessage({ type: "control_worker_initialized", stats });
} catch (error) {
  parent.postMessage({
    type: "control_worker_fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

parent.on("message", (message: Record<string, unknown>) => {
  if (message.type === "activate" && typeof message.connectionId === "string") {
    const generationChanged = activeConnectionId !== message.connectionId;
    activeConnectionId = message.connectionId;
    reconnectAttempt = 0;
    if (generationChanged && socket && socket.readyState <= WebSocket.OPEN) {
      socket.close(1000, "data connection generation changed");
      return;
    }
    connect();
    return;
  }
  if (message.type === "control_domain_result" && typeof message.workId === "string") {
    void commitDomainResult(message.workId, recordField(message.response));
    return;
  }
  if (message.type === "control_domain_failure" && typeof message.workId === "string") {
    void commitDomainFailure(message.workId, message.message);
    return;
  }
  if (message.type === "shutdown") {
    stopping = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    runtime.close();
  }
});

async function commitDomainResult(
  workId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await runtime.handleDomainResult(workId, response);
  if (!workId.startsWith("durable:")) {
    parent.postMessage({ type: "control_domain_committed", workId });
  }
}

async function commitDomainFailure(workId: string, error: unknown): Promise<void> {
  await runtime.handleDomainFailure(workId, error);
  if (!workId.startsWith("durable:")) {
    parent.postMessage({ type: "control_domain_committed", workId });
  }
}

function connect(): void {
  if (stopping || !activeConnectionId) return;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const headers: Record<string, string> = {};
  if (input.authBearerToken) headers.Authorization = `Bearer ${input.authBearerToken}`;
  const ws = new WebSocket(controlUrl(input.upstreamUrl), { headers });
  socket = ws;
  ws.once("open", () => {
    sendOn(ws, {
      type: "node_control_register",
      node_id: input.nodeId,
      connection_id: activeConnectionId,
    }).catch(() => ws.close());
  });
  ws.on("message", (raw) => {
    void handleFrame(ws, parseFrame(raw)).catch(() => ws.close());
  });
  ws.once("close", () => {
    if (socket === ws) socket = undefined;
    runtime.disconnect();
    scheduleReconnect();
  });
  ws.once("error", () => {
    ws.close();
  });
}

function requireParentPort(): NonNullable<typeof parentPort> {
  if (!parentPort) throw new Error("Control inbox worker requires parentPort");
  return parentPort;
}

async function handleFrame(
  ws: WebSocket,
  frame: Record<string, unknown>,
): Promise<void> {
  if (frame.type === "node_control_register_ack") {
    if (
      frame.node_id !== input.nodeId
      || frame.connection_id !== activeConnectionId
    ) {
      throw new Error("Control registration ACK does not match the active data generation");
    }
    await runtime.connect(async (outbound) => await sendOn(ws, outbound));
    await sendOn(ws, { type: "node_control_ready" });
    reconnectAttempt = 0;
    return;
  }
  if (frame.type === "node_control_ready_ack") return;
  if (frame.type === "control_result_ack" && typeof frame.resultId === "string") {
    runtime.acknowledgeResult(frame.resultId);
    return;
  }
  await runtime.handleCommand(frame);
}

function scheduleReconnect(): void {
  if (stopping || !activeConnectionId || reconnectTimer) return;
  const delayMs = Math.min(5_000, 250 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delayMs);
}

async function sendOn(
  ws: WebSocket,
  frame: Record<string, unknown>,
): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("Control WebSocket is not open");
  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve());
  });
}

function controlUrl(upstreamUrl: string): string {
  const url = new URL(upstreamUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/control`;
  return url.toString();
}

function parseFrame(raw: WebSocket.RawData): Record<string, unknown> {
  const value = JSON.parse(raw.toString()) as unknown;
  return recordField(value);
}

function recordField(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Control frame must be an object");
  }
  return value as Record<string, unknown>;
}
