import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WSServerWebSocket } from "ws";
import pino from "pino";
import type { AddressInfo } from "node:net";

import { AgentRegistry, type AgentProfile } from "../src/agent_registry.js";
import { UpstreamAdapter, isConnectionError } from "../src/upstream/adapter.js";
import type { TaskExecutor } from "../src/task/task_executor.js";
import type { TaskManager } from "../src/task/task_manager.js";
import type { SessionDB } from "../src/db/session_db.js";

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

function makeDeps(
  opts: {
    agents?: AgentProfile[];
    runningCount?: number;
    sessionDb?: SessionDB;
  } = {},
) {
  const agentRegistry = new AgentRegistry(opts.agents ?? [codexAgent]);
  const taskManager = {
    listTasks: () =>
      Array(opts.runningCount ?? 0)
        .fill(null)
        .map(() => ({ status: "running" as const })),
    createTask: async () => {
      throw new Error("createTask not stubbed in this test");
    },
    cancelTask: async () => false,
    deleteTask: async () => undefined,
    shutdown: async () => undefined,
    getTask: () => undefined,
    setTaskStatus: () => undefined,
  } as unknown as TaskManager;
  const taskExecutor = {
    startExecution: () => undefined,
  } as unknown as TaskExecutor;
  return { agentRegistry, taskManager, taskExecutor, sessionDb: opts.sessionDb };
}

interface MockOrch {
  port: number;
  url: string;
  server: WebSocketServer;
  receivedMessages: unknown[];
  sockets: WSServerWebSocket[];
  expectedAuthHeader?: string;
}

async function startMockOrch(
  opts: {
    authToken?: string;
    autoPong?: boolean;
    pingOnRegister?: boolean;
  } = {},
): Promise<MockOrch> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/ws/node`;
  const received: unknown[] = [];
  const sockets: WSServerWebSocket[] = [];

  wss.on("connection", (socket, req) => {
    // Bearer auth 확인 (orch ws_handler.py L52-62 등가)
    if (opts.authToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.authToken}`) {
        socket.close(4401, "auth required");
        return;
      }
    }
    sockets.push(socket);
    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
      try {
        const msg = JSON.parse(text);
        received.push(msg);
        if (
          opts.pingOnRegister &&
          typeof msg === "object" &&
          msg !== null &&
          (msg as Record<string, unknown>).type === "node_register"
        ) {
          socket.send(JSON.stringify({
            type: "app_heartbeat_ping",
            sentAt: "2026-06-08T00:00:00Z",
          }));
        }
        if (
          opts.autoPong &&
          typeof msg === "object" &&
          msg !== null &&
          (msg as Record<string, unknown>).type === "app_heartbeat_ping"
        ) {
          socket.send(JSON.stringify({
            type: "app_heartbeat_pong",
            sentAt: (msg as Record<string, unknown>).sentAt,
          }));
        }
      } catch {
        received.push(text);
      }
    });
  });

  return { port, url, server: wss, receivedMessages: received, sockets };
}

async function stopMockOrch(orch: MockOrch): Promise<void> {
  for (const sock of orch.sockets) sock.close();
  await new Promise<void>((r) => orch.server.close(() => r()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const silentLogger = pino({ level: "silent" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("UpstreamAdapter", () => {
  let orch: MockOrch;

  beforeEach(async () => {
    orch = await startMockOrch();
  });

  afterEach(async () => {
    await stopMockOrch(orch);
  });

  it("연결 후 첫 메시지로 node_register payload를 발행한다", async () => {
    const adapter = new UpstreamAdapter(
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
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.receivedMessages.length >= 1);

    const first = orch.receivedMessages[0] as Record<string, unknown>;
    expect(first.type).toBe("node_register");
    expect(first.node_id).toBe("eias-shopping-ts");
    expect(first.supported_backends).toEqual(["codex"]);
    // Phase B-3 + cogito aggregate: registry capacity and TS reflection capability.
    expect(first.capabilities).toEqual({
      max_concurrent: 1,
      reflect_brief: true,
      app_heartbeat_v1: true,
    });
    // PR(portrait wire): agents 매핑에 portrait_url 추가 (Python adapter.py:212-233 정합).
    // portrait_path 미설정 fixture → portrait_url=""·portrait_b64 키 미박힘.
    expect(first.agents).toEqual([
      { id: "codex-default", name: "Codex Default", backend: "codex", portrait_url: "" },
    ]);

    await adapter.shutdown();
  });

  it("registry 변경 후 같은 WebSocket으로 node_register를 재공지한다", async () => {
    const deps = makeDeps();
    const adapter = new UpstreamAdapter(
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
      silentLogger,
      deps,
    );

    void adapter.run();
    await waitFor(() => orch.receivedMessages.length >= 1);

    deps.agentRegistry.replace([
      codexAgent,
      {
        id: "fable",
        name: "서소영 Fable",
        backend: "codex",
        workspace_dir: "/tmp/fable",
      },
    ]);
    await adapter.reannounceAgentCatalog();
    await waitFor(
      () =>
        orch.receivedMessages.filter(
          (msg) => (msg as Record<string, unknown>).type === "node_register",
        ).length >= 2,
    );

    const registerMessages = orch.receivedMessages.filter(
      (msg) => (msg as Record<string, unknown>).type === "node_register",
    ) as Array<Record<string, unknown>>;
    const latest = registerMessages.at(-1) as Record<string, unknown>;
    expect((latest.agents as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([
      "codex-default",
      "fable",
    ]);
    expect(latest.capabilities).toMatchObject({ max_concurrent: 2 });

    await adapter.shutdown();
  });

  it("sessionDb가 있으면 node_register 직후 현재 세션 dump를 sessions_update로 보낸다", async () => {
    const sessionDb = {
      listSessionsForUpstreamDump: vi.fn(async () => ({
        sessions: [
          {
            session_id: "sess-1",
            display_name: "Running",
            status: "running",
            session_type: "codex",
            created_at: new Date("2026-06-07T00:00:00Z"),
            updated_at: new Date("2026-06-07T00:01:00Z"),
            event_count: 3,
            away_summary: null,
            caller_session_id: null,
            last_event_id: 3,
            last_read_event_id: 0,
            node_id: "eias-shopping-ts",
          },
        ],
        total: 1,
      })),
    } as unknown as SessionDB;
    const adapter = new UpstreamAdapter(
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
      silentLogger,
      makeDeps({ sessionDb }),
    );

    void adapter.run();
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "sessions_update",
      ),
    );

    expect(sessionDb.listSessionsForUpstreamDump).toHaveBeenCalledWith({
      limit: 10_000,
      offset: 0,
      nodeId: "eias-shopping-ts",
    });
    const second = orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "sessions_update",
    ) as Record<string, unknown>;
    expect(second).toMatchObject({
      type: "sessions_update",
      total: 1,
      requestId: "",
    });
    expect((second.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({
      session_id: "sess-1",
      last_event_id: 3,
    });

    await adapter.shutdown();
  });

  it("health_check 명령을 받으면 health_status로 응답한다", async () => {
    const adapter = new UpstreamAdapter(
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
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    // orch가 health_check를 보냄
    orch.sockets[0]!.send(JSON.stringify({ type: "health_check", requestId: "hc-1" }));

    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "health_status",
      ),
    );

    const reply = orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "health_status",
    ) as Record<string, unknown>;
    expect(reply.type).toBe("health_status");
    expect(reply.node_id).toBe("eias-shopping-ts");
    expect(reply.requestId).toBe("hc-1");
    // Phase B-3: max_concurrent=agents.length=1, active=runningTasks=0
    expect(reply.runners).toEqual({ max_concurrent: 1, active: 0 });

    await adapter.shutdown();
  });

  it("respond 필수 필드 누락 시 명시 error 응답", async () => {
    const adapter = new UpstreamAdapter(
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
      silentLogger,
      makeDeps(),
    );
    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    // P4에서 respond는 implemented — 필수 필드 누락은 명시 validation error.
    orch.sockets[0]!.send(JSON.stringify({ type: "respond", requestId: "r-1" }));
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "error",
      ),
    );

    const reply = orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "error",
    ) as Record<string, unknown>;
    expect(reply.type).toBe("error");
    expect(reply.command_type).toBe("respond");
    expect(reply.requestId).toBe("r-1");
    expect(reply.message).toContain("respond requires agentSessionId");

    await adapter.shutdown();
  });

  it("AUTH_BEARER_TOKEN 헤더로 Bearer 인증을 보낸다", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ authToken: "test-token" });

    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "test-token",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );
    void adapter.run();
    await waitFor(() => orch.receivedMessages.length >= 1);

    expect(orch.receivedMessages.length).toBeGreaterThan(0);
    await adapter.shutdown();
  });

  it("잘못된 AUTH 토큰이면 연결 close → 재연결 시도 (running 종료 후 정리)", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ authToken: "correct-token" });

    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "wrong-token",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
      },
      silentLogger,
      makeDeps(),
    );
    void adapter.run();

    // 잠시 대기 — 토큰 거부로 receivedMessages 0건 유지되어야 함
    await new Promise((r) => setTimeout(r, 200));
    expect(orch.receivedMessages).toHaveLength(0);

    await adapter.shutdown();
  });

  it("orch app_heartbeat_ping에 app_heartbeat_pong으로 응답한다", async () => {
    const adapter = new UpstreamAdapter(
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
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    orch.sockets[0]!.send(JSON.stringify({
      type: "app_heartbeat_ping",
      sentAt: "2026-06-08T00:00:00Z",
    }));

    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "app_heartbeat_pong",
      ),
    );

    const pong = orch.receivedMessages.find(
      (msg) => (msg as Record<string, unknown>).type === "app_heartbeat_pong",
    ) as Record<string, unknown>;
    expect(pong.sentAt).toBe("2026-06-08T00:00:00Z");

    await adapter.shutdown();
  });

  it("node_register 직후 초기 세션 dump가 지연되어도 orch heartbeat ping에 응답한다", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ pingOnRegister: true });

    const sessionDump = deferred<{
      sessions: [];
      total: number;
    }>();
    const sessionDb = {
      listSessionsForUpstreamDump: vi.fn(() => sessionDump.promise),
    } as unknown as SessionDB;
    const adapter = new UpstreamAdapter(
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
      silentLogger,
      makeDeps({ sessionDb }),
    );

    void adapter.run();
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "node_register",
      ),
    );
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "app_heartbeat_pong",
      ),
      500,
    );

    sessionDump.resolve({ sessions: [], total: 0 });
    await waitFor(() =>
      orch.receivedMessages.some(
        (msg) => (msg as Record<string, unknown>).type === "sessions_update",
      ),
    );

    await adapter.shutdown();
  });

  it("app heartbeat pong이 없으면 연결을 닫고 재연결 루프로 넘긴다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        userPortraitPath: "",
        isProduction: false,
        heartbeatIntervalMs: 10,
        heartbeatMaxMissed: 1,
      },
      silentLogger,
      makeDeps(),
    );

    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    orch.sockets[0]!.send(JSON.stringify({
      type: "app_heartbeat_ping",
      sentAt: "2026-06-08T00:00:00Z",
    }));

    await waitFor(
      () =>
        orch.sockets[0]!.readyState === orch.sockets[0]!.CLOSED ||
        orch.sockets[0]!.readyState === orch.sockets[0]!.CLOSING,
      500,
    );

    await adapter.shutdown();
  });
});

describe("isConnectionError", () => {
  it("ECONNREFUSED는 연결 오류", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isConnectionError(err)).toBe(true);
  });

  it("ETIMEDOUT, ENOTFOUND, ECONNRESET, EHOSTUNREACH, ENETUNREACH 모두 연결 오류", () => {
    const codes = ["ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"];
    for (const code of codes) {
      const err = Object.assign(new Error(`x ${code}`), { code });
      expect(isConnectionError(err), `for ${code}`).toBe(true);
    }
  });

  it("WS handshake 메시지는 연결 오류", () => {
    const err = new Error("Unexpected server response: 401");
    expect(isConnectionError(err)).toBe(true);
  });

  it("일반 TypeError는 연결 오류가 아님", () => {
    expect(isConnectionError(new TypeError("cannot read property foo of undefined"))).toBe(false);
  });

  it("Error 아닌 값은 false", () => {
    expect(isConnectionError("string error")).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});
