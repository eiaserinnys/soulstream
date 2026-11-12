import type { AddressInfo } from "node:net";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WSServerWebSocket } from "ws";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import { UpstreamAdapter } from "../../src/upstream/adapter.js";

type MockOrch = {
  url: string;
  server: WebSocketServer;
  receivedMessages: unknown[];
  sockets: WSServerWebSocket[];
};

describe("UpstreamAdapter runner inventory after restart", () => {
  let orch: MockOrch;

  beforeEach(async () => {
    orch = await startMockOrch();
  });

  afterEach(async () => {
    for (const socket of orch.sockets) socket.close();
    await new Promise<void>((resolve) => orch.server.close(() => resolve()));
  });

  it("omits a hydrated initializing task that lost both registration and activation", async () => {
    const barrier = deferred<void>();
    const tasks = [
      makeTask({ agentSessionId: "hydrated-dead", hydratedFromDb: true }),
      makeTask({
        agentSessionId: "hydrated-barrier",
        hydratedFromDb: true,
        executionActivation: {
          promise: barrier.promise,
          resolve: () => undefined,
          reject: () => undefined,
        },
      }),
      makeTask({
        agentSessionId: "hydrated-registered",
        hydratedFromDb: true,
        executionRegistration: {
          ownerKind: "adopted_runner",
          manifestId: "manifest-restored",
          runtimeEnvIdentity: "runtime-restored",
          registrationId: "registration-restored",
          pid: 42_002,
          startIdentity: "start-restored",
          executionCommandId: "command-restored",
          ownershipGeneration: 3,
        },
      }),
      makeTask({ agentSessionId: "in-memory-initializing" }),
      makeTask({ agentSessionId: "live-running", status: "running" }),
    ];
    const listLiveRunnerSessionIds = vi.fn(async () => ["runner-live"]);
    const adapter = createAdapter(orch, tasks, listLiveRunnerSessionIds, pino({ level: "silent" }));

    void adapter.run();
    await waitFor(() => orch.receivedMessages.some(isRunnerInventory));

    const inventory = orch.receivedMessages.find(isRunnerInventory) as Record<string, unknown>;
    expect([...(inventory.running_session_ids as string[])].sort()).toEqual([
      "hydrated-barrier",
      "hydrated-registered",
      "in-memory-initializing",
      "live-running",
      "runner-live",
    ]);
    await adapter.shutdown();
  });
});

function makeTask(overrides: Partial<Task> & { agentSessionId: string }): Task {
  return {
    prompt: "original prompt",
    status: "initializing",
    createdAt: new Date("2026-11-13T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
    ...overrides,
  } as Task;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAdapter(
  orch: MockOrch,
  tasks: Task[],
  listLiveRunnerSessionIds: () => Promise<string[]>,
  logger: ReturnType<typeof pino>,
): UpstreamAdapter {
  const sessionDb = {
    listSessionsForUpstreamDump: vi.fn(async () => ({ sessions: [], total: 0 })),
  } as unknown as SessionDB;
  const taskManager = {
    listTasks: () => tasks,
    createTask: async () => { throw new Error("unused"); },
    cancelTask: async () => false,
    deleteTask: async () => undefined,
    shutdown: async () => undefined,
    getTask: () => undefined,
    setTaskStatus: () => undefined,
  } as unknown as TaskManager;
  return new UpstreamAdapter(
    {
      url: orch.url,
      nodeId: "eias-shopping-ts",
      host: "127.0.0.1",
      port: 4205,
      authBearerToken: "",
      userName: "",
      userPortraitPath: "",
      isProduction: false,
    },
    logger,
    {
      agentRegistry: new AgentRegistry([]),
      taskManager,
      taskExecutor: { startNewExecution: () => undefined } as unknown as TaskExecutor,
      providerUsage: { fetchUsage: vi.fn() },
      sessionDb,
      listLiveRunnerSessionIds,
    },
  );
}

async function startMockOrch(): Promise<MockOrch> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const receivedMessages: unknown[] = [];
  const sockets: WSServerWebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      receivedMessages.push(message);
      if (message.type === "node_register") {
        socket.send(JSON.stringify({
          type: "node_register_ack",
          node_id: message.node_id,
          capabilities: { runner_inventory_v1: true },
        }));
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${port}/ws/node`,
    server,
    receivedMessages,
    sockets,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isRunnerInventory(message: unknown): boolean {
  return typeof message === "object" && message !== null
    && (message as Record<string, unknown>).type === "runner_inventory";
}
