import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  PerNodeSessionCache,
  SessionCommandTransportBridge,
  SessionCommandRouter,
  createApp,
  loadContractFixtures,
  registerSessionCommandRoutes,
  sessionCommandRouteAuthRequirements,
  type CreateSessionNodeCommandPayload,
  type NodeRegistrationPayload,
} from "../src/index.js";

describe("session command HTTP route harness", () => {
  const fixtures = loadContractFixtures();
  const reconnect = fixtures.fakeNodeReconnect;
  const upstream = fixtures.upstreamWsWire;
  const config = {
    environment: "test" as const,
    databaseUrl: "postgresql://test/test",
    authBearerToken: "test-token",
  };

  function createHarness(): {
    registry: InMemoryNodeRegistry;
    transports: NodeCommandTransportHub;
    router: SessionCommandRouter;
    bridge: SessionCommandTransportBridge;
  } {
    const sessionCache = new PerNodeSessionCache();
    const registry = new InMemoryNodeRegistry({
      sessionCache,
      nowMs: () => 1_700_000_000_000,
      requestIdGenerator: ({ sequence, commandType, nowMs }) =>
        `route-${commandType}-${sequence}-${nowMs}`,
    });
    const transports = new NodeCommandTransportHub();
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({ registry, transports });
    return { registry, transports, router, bridge };
  }

  function registerNode(registry: InMemoryNodeRegistry): string {
    return registry.registerNode(
      reconnect.registration as NodeRegistrationPayload,
    ).node.connectionId;
  }

  async function createExistingSession(
    registry: InMemoryNodeRegistry,
  ): Promise<void> {
    const command = registry.createCommand(
      "fake-node",
      reconnect.command as CreateSessionNodeCommandPayload,
    );
    registry.receiveNodeMessage("fake-node", {
      ...reconnect.ack,
      requestId: command.requestId,
    });
    await expect(command.result).resolves.toMatchObject({
      agentSessionId: "sess-contract",
    });
  }

  it("keeps session command routes disabled on the default app", async () => {
    const app = createApp({ config });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { prompt: "hello" },
    });
    const respondResponse = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/respond",
      payload: { request_id: "input-req-contract", answers: {} },
    });

    expect(createResponse.statusCode).toBe(404);
    expect(respondResponse.statusCode).toBe(404);
  });

  it("registers only the two auth-required session command routes when explicitly enabled", async () => {
    const { router, bridge } = createHarness();
    const app = createApp({
      config,
      sessionCommandRoutes: { router, bridge },
    });

    expect(sessionCommandRouteAuthRequirements).toEqual({
      "POST /api/sessions": true,
      "POST /api/sessions/{session_id}/respond": true,
    });
    expect(
      fixtures.routeInventory.routes
        .filter((route) => route.name === "create_session" || route.name === "respond")
        .map((route) => [route.methods[0], route.path, route.authRequired]),
    ).toEqual([
      ["POST", "/api/sessions", true],
      ["POST", "/api/sessions/{session_id}/respond", true],
    ]);

    expect(await app.inject({ method: "GET", url: "/api/sessions" })).toMatchObject({
      statusCode: 404,
    });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/intervene",
        payload: { text: "not this phase" },
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("preserves legacy whitespace-only prompts but rejects them for page-anchored creates", async () => {
    const { registry, transports, router, bridge } = createHarness();
    const connectionId = registerNode(registry);
    const sent: Array<Record<string, unknown>> = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          sent.push(message);
          registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            {
              type: "session_created",
              requestId: message.requestId,
              agentSessionId: message.agentSessionId,
            },
          );
        },
      },
    });
    const app = createApp({ config, sessionCommandRoutes: { router, bridge } });

    const legacy = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { prompt: "   ", profile: "claude-roselin" },
    });
    const anchored = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        prompt: "   ",
        profile: "claude-roselin",
        pageAnchor: { pageId: "page-a", blockId: "block-a", expectedVersion: 7 },
      },
    });

    expect(legacy.statusCode).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ prompt: "   " });
    expect(anchored.statusCode).toBe(400);
  });

  it("rejects malformed page anchors before dispatch", async () => {
    const { registry, transports, router, bridge } = createHarness();
    const connectionId = registerNode(registry);
    const send = vi.fn((data: string) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      registry.receiveNodeMessage(
        { nodeId: "fake-node", connectionId },
        {
          type: "session_created",
          requestId: message.requestId,
          agentSessionId: message.agentSessionId,
        },
      );
    });
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: { send },
    });
    const app = createApp({ config, sessionCommandRoutes: { router, bridge } });
    expect((await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { prompt: "hello", profile: "claude-roselin", pageAnchor: { pageId: "page-a" } },
    })).statusCode).toBe(400);
    for (const pageAnchor of [
      { pageId: "", blockId: "block-a", expectedVersion: 7 },
      { pageId: "   ", blockId: "block-a", expectedVersion: 7 },
      { pageId: "page-a", blockId: "", expectedVersion: 7 },
      { pageId: "page-a", blockId: "   ", expectedVersion: 7 },
    ]) {
      expect((await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { prompt: "hello", profile: "claude-roselin", pageAnchor },
      })).statusCode).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("converts POST /api/sessions body into a create_session node command and returns the Python response shape", async () => {
    const { registry, transports, router, bridge } = createHarness();
    const connectionId = registerNode(registry);
    const sent: Array<Record<string, unknown>> = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          sent.push(message);
          registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            {
              type: "session_created",
              requestId: message.requestId,
              agentSessionId: message.agentSessionId,
            },
          );
        },
      },
    });
    const app = createApp({
      config,
      sessionCommandRoutes: { router, bridge },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        prompt: "hello",
        profile: "claude-roselin",
        folderId: "folder-1",
        agentSessionId: "client-selected-session",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      agentSessionId: sent[0]?.agentSessionId,
      nodeId: "fake-node",
      prompt: "hello",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "create_session",
      prompt: "hello",
      profile: "claude-roselin",
      folderId: "folder-1",
      agentSessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      requestId: "route-create_session-1-1700000000000",
    });
    expect(sent[0]?.agentSessionId).not.toBe("client-selected-session");
  });

  it("preserves pageAnchor, client recovery id, and non-fatal worker warnings", async () => {
    const { registry, transports, router, bridge } = createHarness();
    const connectionId = registerNode(registry);
    const sent: Array<Record<string, unknown>> = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          sent.push(message);
          registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            {
              type: "session_created",
              requestId: message.requestId,
              agentSessionId: message.agentSessionId,
              warnings: [{ code: "PAGE_BINDING_PENDING", message: "Binding will retry." }],
            },
          );
        },
      },
    });
    const app = createApp({ config, sessionCommandRoutes: { router, bridge } });
    const recoveryId = "8c55c4d8-625b-4b1f-92ec-81dcb52ae453";

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        agentSessionId: recoveryId,
        prompt: "hello",
        profile: "claude-roselin",
        pageAnchor: { pageId: "page-a", blockId: "block-a", expectedVersion: 7 },
      },
    });

    expect(sent[0]).toMatchObject({
      agentSessionId: recoveryId,
      pageAnchor: { pageId: "page-a", blockId: "block-a", expectedVersion: 7 },
    });
    expect(response.json()).toMatchObject({
      agentSessionId: recoveryId,
      warnings: [{ code: "PAGE_BINDING_PENDING", message: "Binding will retry." }],
    });
  });


  it("rejects a create_session ack that changes the server-generated session id", async () => {
    const { registry, transports, router, bridge } = createHarness();
    const connectionId = registerNode(registry);
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            {
              type: "session_created",
              requestId: message.requestId,
              agentSessionId: "different-session-id",
            },
          );
        },
      },
    });
    const app = createApp({
      config,
      sessionCommandRoutes: { router, bridge },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { prompt: "hello", profile: "claude-roselin" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "SESSION_ID_MISMATCH",
        message: "create_session ack changed the server-generated agentSessionId",
      },
    });
  });

  it("returns a task-scoped idempotent response without dispatching another node command", async () => {
    const { registry, transports, router, bridge } = createHarness();
    const connectionId = registerNode(registry);
    const send = vi.fn();
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: { send },
    });
    const app = createApp({
      config,
      sessionCommandRoutes: {
        router,
        bridge,
        createSessionLifecycle: {
          prepare: vi.fn(async ({ body }) => ({
            payload: body,
            existingResponse: {
              agentSessionId: "existing-child",
              nodeId: "fake-node",
              task: { id: "child-task", status: "in_progress" as const },
              taskOperation: { id: "op-1", operationType: "start_child_session" },
              taskEventId: 303,
              idempotent: true,
            },
          })),
          complete: vi.fn(async () => ({})),
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        prompt: "child",
        parentTaskId: "parent-task",
        taskIdempotencyKey: "idem-child",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      agentSessionId: "existing-child",
      task: { id: "child-task" },
      taskOperation: { operationType: "start_child_session" },
      taskEventId: 303,
      idempotent: true,
      prompt: "child",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("maps respond request_id to inputRequestId without letting body.requestId override the command requestId", async () => {
    const { registry, transports, router, bridge } = createHarness();
    const connectionId = registerNode(registry);
    await createExistingSession(registry);
    const sent: Array<Record<string, unknown>> = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          sent.push(message);
          registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            {
              type: "respond_ack",
              requestId: message.requestId,
              status: "ok",
              inputRequestId: message.inputRequestId,
            },
          );
        },
      },
    });
    const app = createApp({
      config,
      sessionCommandRoutes: { router, bridge },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/respond",
      payload: {
        request_id: upstream.outbound.respond.inputRequestId,
        requestId: "malicious-command-id",
        answers: upstream.outbound.respond.answers,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      inputRequestId: "input-req-contract",
    });
    expect(sent[0]).toMatchObject({
      type: "respond",
      agentSessionId: "sess-contract",
      inputRequestId: "input-req-contract",
      answers: { choice: "yes" },
      requestId: "route-respond-2-1700000000000",
    });
    expect(sent[0]?.requestId).not.toBe(sent[0]?.inputRequestId);
    expect(sent[0]?.requestId).not.toBe("malicious-command-id");
  });

  it("maps route and transport failures to HTTP status codes without pending leaks", async () => {
    const { registry, transports, router, bridge } = createHarness();
    const app = createApp({
      config,
      sessionCommandRoutes: { router, bridge },
    });

    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { prompt: "hello" },
      }),
    ).toMatchObject({ statusCode: 503 });

    const connectionId = registerNode(registry);
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { prompt: "hello" },
      }),
    ).toMatchObject({ statusCode: 503 });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });

    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: { send: () => { throw new Error("send failed"); } },
    });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { prompt: "hello" },
      }),
    ).toMatchObject({ statusCode: 503 });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });

    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/missing/respond",
        payload: { request_id: "input-req-contract", answers: {} },
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("maps respond ack error codes to Python-compatible HTTP statuses", async () => {
    const cases = [
      ["SESSION_NOT_FOUND", 404],
      ["SESSION_NOT_RUNNING", 409],
      ["REQUEST_NOT_PENDING", 422],
      ["INPUT_REQUEST_EXPIRED", 422],
      ["INPUT_REQUEST_ALREADY_RESPONDED", 422],
      ["INPUT_RESPONSE_NOT_SUPPORTED", 422],
    ] as const;

    for (const [code, statusCode] of cases) {
      const { registry, transports, router, bridge } = createHarness();
      const connectionId = registerNode(registry);
      await createExistingSession(registry);
      transports.attach({
        nodeId: "fake-node",
        connectionId,
        transport: {
          send: (data) => {
            const message = JSON.parse(data) as Record<string, unknown>;
            registry.receiveNodeMessage(
              { nodeId: "fake-node", connectionId },
              {
                type: "respond_ack",
                requestId: message.requestId,
                status: "error",
                code,
                message: `ack ${code}`,
                inputRequestId: message.inputRequestId,
              },
            );
          },
        },
      });
      const app = createApp({
        config,
        sessionCommandRoutes: { router, bridge },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/respond",
        payload: { request_id: "input-req-contract", answers: {} },
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        error: {
          code,
          inputRequestId: "input-req-contract",
        },
      });
    }
  });

  it("returns 400 for invalid route bodies", async () => {
    const { router, bridge } = createHarness();
    const app = createApp({
      config,
      sessionCommandRoutes: { router, bridge },
    });

    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { "content-type": "application/json" },
        payload: "{",
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: ["not", "object"],
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {},
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/respond",
        payload: { answers: {} },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/respond",
        payload: { request_id: "input-req-contract", answers: [] },
      }),
    ).toMatchObject({ statusCode: 400 });
  });

  it("can be registered directly on a Fastify instance for route-boundary tests", async () => {
    const { router, bridge } = createHarness();
    const app = createApp({ config });

    registerSessionCommandRoutes(app, { router, bridge });

    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { prompt: "hello" },
      }),
    ).toMatchObject({ statusCode: 503 });
  });
});
