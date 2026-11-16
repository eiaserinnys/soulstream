/**
 * 노드 로컬 notification DLQ 라우트와 CLI 공통부.
 *
 * 라우트는 서비스 토큰과 full 세션 토큰(ssf1)을 받고 restricted(ssr1)는 403,
 * 토큰 없음·위조는 401이다. 실제 orch 호출은 서버 자신의 클라이언트가 한다.
 * CLI는 orch가 아니라 로컬 내부 MCP 주소를 부르고 env 토큰을 쓴다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDeliveryNotificationOutboxRow } from "../../src/db/session_db_types.js";
import { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  createFullSessionMcpToken,
  createRestrictedMcpToken,
} from "../../src/security/restricted_mcp_auth.js";
import { buildServer } from "../../src/server.js";
import { createNotificationDlqClient } from "../../scripts/notification_dlq_cli_common.js";

const KEY = "test-notification-dlq-key-0001";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SERVICE = `Bearer ${KEY}`;
const FULL = `Bearer ${createFullSessionMcpToken(SESSION_A, KEY)}`;
const RESTRICTED = `Bearer ${createRestrictedMcpToken(SESSION_A, KEY)}`;

const DEAD_LETTER_ROW = {
  delivery_id: "delivery-1",
  target_session_id: SESSION_A,
  state: "dead_letter",
  attempt_count: 16,
  last_error: "owner node disconnected",
} as unknown as SessionDeliveryNotificationOutboxRow;

function silentLogger() {
  const noop = () => {};
  return {
    fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, silent: noop,
    level: "silent", child: () => silentLogger(),
  } as unknown as McpRuntime["logger"];
}

function makeRuntime(): McpRuntime {
  return {
    nodeId: "test-node",
    agentsConfigPath: "/tmp/agents.yaml",
    db: new SessionDB(),
    taskManager: { listTasks: () => [], getTask: () => undefined },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: { listAgents: () => [], get: () => undefined },
    catalogService: {},
    logger: silentLogger(),
  } as unknown as McpRuntime;
}

interface DlqHarness {
  routeUrl: string;
  notifications: {
    listDeadLetters: ReturnType<typeof vi.fn>;
    requeueDeadLetter: ReturnType<typeof vi.fn>;
  };
  close: () => Promise<void>;
}

const openServers: DlqHarness[] = [];

async function startDlqServer(options: {
  listImpl?: () => Promise<unknown[]>;
} = {}): Promise<DlqHarness> {
  const notifications = {
    listDeadLetters: vi.fn(options.listImpl ?? (async () => [DEAD_LETTER_ROW])),
    requeueDeadLetter: vi.fn(async () => DEAD_LETTER_ROW),
  };
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: "test-node",
    logger: silentLogger() as never,
    mcp: {
      runtime: makeRuntime(),
      path: "/mcp",
      auth: {
        requireAuth: true,
        bearerToken: KEY,
        allowedHosts: ["127.0.0.1", "localhost"],
      },
    },
    notificationDlq: { notifications },
  });
  const internal = server.internalMcpServer;
  if (!internal) throw new Error("internal MCP server was not built");
  const baseUrl = await internal.listen({ host: "127.0.0.1", port: 0 });
  const harness: DlqHarness = {
    routeUrl: `${baseUrl}/mcp/internal/notification-dlq`,
    notifications,
    close: async () => {
      await server.closeMcp?.();
      await internal.close();
      await server.close();
    },
  };
  openServers.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((harness) => harness.close()));
  vi.unstubAllGlobals();
});

describe("notification DLQ routes", () => {
  it("lists dead letters for the service token and ssf1", async () => {
    const harness = await startDlqServer();

    const service = await fetch(`${harness.routeUrl}/dead-letters?limit=7`, {
      headers: { authorization: SERVICE },
    });
    expect(service.status).toBe(200);
    expect((await service.json() as { rows: unknown[] }).rows).toHaveLength(1);
    expect(harness.notifications.listDeadLetters).toHaveBeenCalledWith(7);

    const full = await fetch(`${harness.routeUrl}/dead-letters`, {
      headers: { authorization: FULL },
    });
    expect(full.status).toBe(200);
    expect(harness.notifications.listDeadLetters).toHaveBeenCalledTimes(2);
  });

  it("rejects restricted credentials with 403", async () => {
    const harness = await startDlqServer();
    const response = await fetch(`${harness.routeUrl}/dead-letters`, {
      headers: { authorization: RESTRICTED },
    });
    expect(response.status).toBe(403);
    expect(harness.notifications.listDeadLetters).not.toHaveBeenCalled();
  });

  it("rejects missing and forged credentials with 401", async () => {
    const harness = await startDlqServer();
    const missing = await fetch(`${harness.routeUrl}/dead-letters`);
    expect(missing.status).toBe(401);

    const forged = `Bearer ${createFullSessionMcpToken(SESSION_A, "another-key")}`;
    const response = await fetch(`${harness.routeUrl}/dead-letters`, {
      headers: { authorization: forged },
    });
    expect(response.status).toBe(401);
    expect(harness.notifications.listDeadLetters).not.toHaveBeenCalled();
  });

  it("requeues one delivery and validates the request body", async () => {
    const harness = await startDlqServer();
    const response = await fetch(`${harness.routeUrl}/requeue`, {
      method: "POST",
      headers: { authorization: SERVICE, "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: "delivery-1" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { row: { delivery_id: string } }).row.delivery_id)
      .toBe("delivery-1");
    expect(harness.notifications.requeueDeadLetter).toHaveBeenCalledWith("delivery-1");

    const invalid = await fetch(`${harness.routeUrl}/requeue`, {
      method: "POST",
      headers: { authorization: SERVICE, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);
  });

  it("maps an orchestrator host failure to 502", async () => {
    const harness = await startDlqServer({
      listImpl: async () => { throw new Error("upstream down"); },
    });
    const response = await fetch(`${harness.routeUrl}/dead-letters`, {
      headers: { authorization: SERVICE },
    });
    expect(response.status).toBe(502);
  });
});

describe("notification DLQ CLI common", () => {
  it("calls the local internal MCP address with the env token", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ rows: [], row: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const client = createNotificationDlqClient({
      AUTH_BEARER_TOKEN: "session-token",
      MCP_INTERNAL_PORT: "4321",
      MCP_PATH: "/mcp",
    });
    await client.listDeadLetters(25);
    await client.requeueDeadLetter("delivery-1");

    const [listUrl, listInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(listUrl).toBe(
      "http://127.0.0.1:4321/mcp/internal/notification-dlq/dead-letters?limit=25",
    );
    expect((listInit.headers as Record<string, string>).authorization)
      .toBe("Bearer session-token");

    const [requeueUrl, requeueInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(requeueUrl).toBe(
      "http://127.0.0.1:4321/mcp/internal/notification-dlq/requeue",
    );
    expect(requeueInit.body).toBe(JSON.stringify({ deliveryId: "delivery-1" }));
  });

  it("derives the internal port from PORT when MCP_INTERNAL_PORT is absent", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ rows: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const client = createNotificationDlqClient({
      AUTH_BEARER_TOKEN: "session-token",
      PORT: "3105",
    });
    await client.listDeadLetters(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3106/mcp/internal/notification-dlq/dead-letters?limit=1",
    );
  });
});
