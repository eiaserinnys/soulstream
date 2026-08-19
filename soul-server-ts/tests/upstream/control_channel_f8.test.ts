import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import pino from "pino";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { ControlChannelService } from "../../src/upstream/control_channel_service.js";

const roots: string[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map(async (worker) => await worker.terminate()));
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
});

describe("F8 control/data isolation", () => {
  it("keeps intervention, cancel, and health ACKs bounded while main/data are stalled", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-f8-"));
    roots.push(root);
    const orch = new Worker(ORCH_WORKER_SOURCE, { eval: true });
    workers.push(orch);
    const listening = await waitForWorkerMessage<{ type: "listening"; port: number }>(
      orch,
      (message) => message.type === "listening",
    );

    let controlService!: ControlChannelService;
    controlService = new ControlChannelService({
      nodeId: "node-f8",
      upstreamUrl: `ws://127.0.0.1:${listening.port}/ws/node`,
      authBearerToken: "",
      runnerStateDir: root,
      logger: pino({ level: "silent" }),
      dispatchCommand: async () => await new Promise<void>(() => undefined),
    });
    controlService.start();
    controlService.activate("node-f8:1");

    const dataFrames: number[] = [];
    const dataSocket = new WebSocket(`ws://127.0.0.1:${listening.port}/ws/node`);
    dataSocket.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString()) as { sequence: number };
      dataFrames.push(parsed.sequence);
    });
    await waitForSocketOpen(dataSocket);
    await waitForWorkerMessage(orch, (message) => message.type === "control_ready");

    const resultPromise = waitForWorkerMessage<F8Result>(
      orch,
      (message) => message.type === "f8_result",
      10_000,
    );
    orch.postMessage({ type: "run_f8" });

    // The helper worker floods the data socket immediately and emits the three
    // command families after the main heartbeat is stale. Blocking this event
    // loop models the production starvation mode while the control worker stays live.
    const blocker = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(blocker, 0, 0, 1_400);

    const result = await resultPromise;
    expect(result.terminalCount).toBe(60);
    expect(result.maxLatencyMs.intervention).toBeLessThanOrEqual(1_000);
    expect(result.maxLatencyMs.session).toBeLessThanOrEqual(1_000);
    expect(result.maxLatencyMs.health).toBeLessThanOrEqual(1_000);
    expect(result.healthStatuses).toEqual(["unavailable"]);
    for (const family of ["intervention", "session", "health"] as const) {
      expect(result.metrics[family]).toMatchObject({
        windowMs: 5 * 60_000,
        sampleCount: 20,
        p99GateMs: 250,
        maxGateMs: 1_000,
        withinGate: true,
      });
      expect(result.metrics[family]?.p99Ms).toEqual(expect.any(Number));
    }
    await waitFor(() => dataFrames.length === 64);

    dataSocket.close();
    await controlService.shutdown();
  }, 20_000);
});

type F8Result = {
  type: "f8_result";
  terminalCount: number;
  maxLatencyMs: Record<"intervention" | "session" | "health", number>;
  healthStatuses: string[];
  metrics: Record<string, Record<string, unknown>>;
};

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForWorkerMessage<T extends Record<string, unknown>>(
  worker: Worker,
  predicate: (message: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off("message", onMessage);
      reject(new Error("worker message timeout"));
    }, timeoutMs);
    const onMessage = (message: T) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      resolve(message);
    };
    worker.on("message", onMessage);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const ORCH_WORKER_SOURCE = String.raw`
  const { parentPort } = require("node:worker_threads");
  const { WebSocketServer } = require("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let control;
  let data;
  const sentAt = new Map();
  const terminal = [];
  const metrics = {};
  const healthStatuses = new Set();

  server.once("listening", () => {
    parentPort.postMessage({ type: "listening", port: server.address().port });
  });
  server.on("connection", (socket, request) => {
    if (request.url === "/ws/node/control") {
      control = socket;
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "node_control_register") {
          socket.send(JSON.stringify({
            type: "node_control_register_ack",
            node_id: frame.node_id,
            connection_id: frame.connection_id,
          }));
          return;
        }
        if (frame.type === "node_control_ready") {
          socket.send(JSON.stringify({ type: "node_control_ready_ack" }));
          parentPort.postMessage({ type: "control_ready" });
          return;
        }
        if (frame.type === "control_ack_metric") {
          metrics[frame.commandFamily] = frame;
          maybeFinish();
          return;
        }
        if (frame.type === "control_admission_ack" || frame.type === "health_status") {
          const started = sentAt.get(frame.requestId);
          terminal.push({
            family: frame.requestId.split("-")[1],
            latencyMs: Date.now() - started,
          });
          if (frame.type === "health_status") healthStatuses.add(frame.status);
          maybeFinish();
        }
      });
      return;
    }
    data = socket;
  });

  parentPort.on("message", (message) => {
    if (message.type !== "run_f8") return;
    const payload = "x".repeat(512 * 1024);
    for (let sequence = 0; sequence < 64; sequence += 1) {
      data.send(JSON.stringify({ type: "progress", sequence, payload }));
    }
    setTimeout(() => {
      for (let index = 0; index < 20; index += 1) {
        send("intervention", {
          type: "intervene",
          requestId: "req-intervention-" + index,
          agentSessionId: "session-a",
          text: "stop",
        });
        send("session", {
          type: "interrupt_session",
          requestId: "req-session-" + index,
          agentSessionId: "session-a",
        });
        send("health", {
          type: "health_check",
          requestId: "req-health-" + index,
        });
      }
    }, 1_100);
  });

  function send(family, frame) {
    sentAt.set(frame.requestId, Date.now());
    control.send(JSON.stringify(frame));
  }

  function finish() {
    const maxLatencyMs = { intervention: 0, session: 0, health: 0 };
    for (const item of terminal) {
      maxLatencyMs[item.family] = Math.max(maxLatencyMs[item.family], item.latencyMs);
    }
    parentPort.postMessage({
      type: "f8_result",
      terminalCount: terminal.length,
      maxLatencyMs,
      healthStatuses: [...healthStatuses],
      metrics,
    });
  }

  function maybeFinish() {
    if (terminal.length !== 60) return;
    if (!["intervention", "session", "health"].every(
      (family) => metrics[family] && metrics[family].sampleCount === 20
    )) return;
    finish();
  }
`;
