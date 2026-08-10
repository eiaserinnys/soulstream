import type { AddressInfo } from "node:net";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WSServerWebSocket } from "ws";

import { AgentRegistry } from "../src/agent_registry.js";
import type { SessionDB } from "../src/db/session_db.js";
import type { TaskExecutor } from "../src/task/task_executor.js";
import type { TaskManager } from "../src/task/task_manager.js";
import { UpstreamAdapter } from "../src/upstream/adapter.js";

type MockOrch = {
  url: string;
  server: WebSocketServer;
  receivedMessages: unknown[];
  sockets: WSServerWebSocket[];
};

describe("UpstreamAdapter initial reconciliation retry", () => {
  let orch: MockOrch;

  beforeEach(async () => {
    orch = await startMockOrch();
  });

  afterEach(async () => {
    for (const socket of orch.sockets) socket.close();
    await new Promise<void>((resolve) => orch.server.close(() => resolve()));
  });

  it("retries an incomplete runner inventory on the same connection generation until complete", async () => {
    const listLiveRunnerSessionIds = vi.fn()
      .mockRejectedValueOnce(new AggregateError([new Error("partial scan")], "incomplete"))
      .mockResolvedValueOnce(["session-runner"]);
    const adapter = createAdapter(orch, listLiveRunnerSessionIds, pino({ level: "silent" }));

    void adapter.run();
    await waitFor(() => listLiveRunnerSessionIds.mock.calls.length === 2);
    await waitFor(() => orch.receivedMessages.some(isSessionsUpdate));

    const inventory = orch.receivedMessages.find(isSessionsUpdate) as Record<string, unknown>;
    expect(orch.sockets).toHaveLength(1);
    expect(inventory.running_session_ids).toEqual(["session-runner"]);
    await adapter.shutdown();
  });

  it("stops incomplete inventory retries at a bounded limit and logs an explicit error", async () => {
    const listLiveRunnerSessionIds = vi.fn(async () => {
      throw new AggregateError([new Error("partial scan")], "incomplete");
    });
    const logger = pino({ level: "silent" });
    const logError = vi.spyOn(logger, "error");
    const adapter = createAdapter(orch, listLiveRunnerSessionIds, logger);

    void adapter.run();
    await waitFor(() => listLiveRunnerSessionIds.mock.calls.length === 5, 3_000);

    expect(orch.sockets).toHaveLength(1);
    expect(orch.receivedMessages.some(isSessionsUpdate)).toBe(false);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 5, nodeId: "eias-shopping-ts" }),
      "initial sessions_update retry limit exhausted",
    );
    await adapter.shutdown();
  });
});

function createAdapter(
  orch: MockOrch,
  listLiveRunnerSessionIds: () => Promise<string[]>,
  logger: ReturnType<typeof pino>,
): UpstreamAdapter {
  const sessionDb = {
    listSessionsForUpstreamDump: vi.fn(async () => ({ sessions: [], total: 0 })),
  } as unknown as SessionDB;
  const taskManager = {
    listTasks: () => [],
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
      taskExecutor: { startExecution: () => undefined } as unknown as TaskExecutor,
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
      receivedMessages.push(JSON.parse(raw.toString()));
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

function isSessionsUpdate(message: unknown): boolean {
  return typeof message === "object" && message !== null
    && (message as Record<string, unknown>).type === "sessions_update";
}
