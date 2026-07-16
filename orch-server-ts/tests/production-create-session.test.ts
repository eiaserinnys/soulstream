import { describe, expect, it, vi } from "vitest";

import {
  createLiveProductionApplication,
  loadOrchServerEnvironment,
  type LiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/index.js";

type TestWebSocket = {
  send: (data: string) => void;
  terminate: () => void;
  on: (
    event: "message",
    handler: (data: string | Buffer | ArrayBuffer) => void,
  ) => void;
};

type WebSocketInjectableApp = {
  injectWS: (
    path: string,
    options: { headers: Record<string, string> },
  ) => Promise<TestWebSocket>;
};

type RegisteredTestNode = {
  nodeId: string;
  ws: TestWebSocket;
};

describe("production create-session route", () => {
  it("generates one immutable agentSessionId before dispatching create_session", async () => {
    const harness = await createProductionHarness();
    try {
      await connectNode(harness, {
        nodeId: "node-a",
        agents: [{ id: "roselin_codex", backend: "claude" }],
        supportedBackends: ["claude"],
      });

      const result = await requestCreateSession(harness, {
        prompt: "hello from dashboard",
        agentId: "roselin_codex",
        profile: "roselin_codex",
        folderId: "folder-a",
      });

      expect(result.command?.agentSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(result.command).toMatchObject({
        type: "create_session",
        prompt: "hello from dashboard",
        profile: "roselin_codex",
        folderId: "folder-a",
        caller_info: { source: "browser" },
      });
      expect(result.command).not.toHaveProperty("agentId");
      expect(result.response.statusCode).toBe(201);
      expect(result.response.json()).toEqual({
        agentSessionId: result.command?.agentSessionId,
        nodeId: "node-a",
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("forces create_session onto the explicitly requested node", async () => {
    const harness = await createProductionHarness();
    try {
      await connectNode(harness, {
        nodeId: "a-default-node",
        agents: [{ id: "seosoyoung", backend: "claude" }],
        supportedBackends: ["claude"],
      });
      await connectNode(harness, {
        nodeId: "z-requested-node",
        agents: [{ id: "seosoyoung", backend: "claude" }],
        supportedBackends: ["claude"],
      });

      const result = await requestCreateSession(harness, {
        prompt: "route to the requested node",
        profile: "seosoyoung",
        nodeId: "z-requested-node",
      });

      expect(result.routedNodeId).toBe("z-requested-node");
      expect(result.response.statusCode).toBe(201);
      expect(result.response.json()).toMatchObject({
        nodeId: "z-requested-node",
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("preserves the soul-app agentId alias instead of defaulting to the node's first profile", async () => {
    const harness = await createProductionHarness();
    try {
      await connectNode(harness, {
        nodeId: "eias-linegames",
        agents: [
          { id: "seosoyoung_codex", backend: "codex" },
          { id: "writer-seosoyoung-opus", backend: "claude" },
        ],
        supportedBackends: ["codex", "claude"],
      });

      const result = await requestCreateSession(harness, {
        prompt: "start the selected writer",
        agentId: "writer-seosoyoung-opus",
        nodeId: "eias-linegames",
      });

      expect(result.routedNodeId).toBe("eias-linegames");
      expect(result.command).toMatchObject({
        profile: "writer-seosoyoung-opus",
      });
      expect(result.command).not.toHaveProperty("agentId");
      expect(result.response.statusCode).toBe(201);
    } finally {
      await closeHarness(harness);
    }
  });

  it("uses the soul-app agentId alias when automatically selecting a node", async () => {
    const harness = await createProductionHarness();
    try {
      await connectNode(harness, {
        nodeId: "a-codex-node",
        agents: [{ id: "seosoyoung_codex", backend: "codex" }],
        supportedBackends: ["codex"],
      });
      await connectNode(harness, {
        nodeId: "z-writer-node",
        agents: [{ id: "writer-seosoyoung-opus", backend: "claude" }],
        supportedBackends: ["claude"],
      });

      const result = await requestCreateSession(harness, {
        prompt: "find the selected writer",
        agentId: "writer-seosoyoung-opus",
      });

      expect(result.routedNodeId).toBe("z-writer-node");
      expect(result.command).toMatchObject({
        profile: "writer-seosoyoung-opus",
      });
      expect(result.command).not.toHaveProperty("agentId");
      expect(result.response.statusCode).toBe(201);
    } finally {
      await closeHarness(harness);
    }
  });

  it("returns 404 without dispatch when the requested node is not connected", async () => {
    const harness = await createProductionHarness();
    try {
      await connectNode(harness, {
        nodeId: "node-a",
        agents: [{ id: "seosoyoung", backend: "claude" }],
        supportedBackends: ["claude"],
      });

      const result = await requestCreateSession(harness, {
        prompt: "missing target",
        profile: "seosoyoung",
        nodeId: "ghost-node",
      });

      expect(result.routedNodeId).toBeUndefined();
      expect(result.response.statusCode).toBe(404);
      expect(result.response.json()).toMatchObject({
        error: { code: "NODE_NOT_FOUND", nodeId: "ghost-node" },
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("returns 404 without dispatch when the profile is absent from the requested node", async () => {
    const harness = await createProductionHarness();
    try {
      await connectNode(harness, {
        nodeId: "node-a",
        agents: [{ id: "other-profile", backend: "claude" }],
        supportedBackends: ["claude"],
      });

      const result = await requestCreateSession(harness, {
        prompt: "missing profile",
        profile: "seosoyoung",
        nodeId: "node-a",
      });

      expect(result.routedNodeId).toBeUndefined();
      expect(result.response.statusCode).toBe(404);
      expect(result.response.json()).toMatchObject({
        error: {
          code: "PROFILE_NOT_FOUND",
          nodeId: "node-a",
          profile: "seosoyoung",
        },
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("returns 409 without dispatch when the requested node cannot run the profile backend", async () => {
    const harness = await createProductionHarness();
    try {
      await connectNode(harness, {
        nodeId: "a-compatible-node",
        agents: [{ id: "seosoyoung", backend: "codex" }],
        supportedBackends: ["codex"],
      });
      await connectNode(harness, {
        nodeId: "z-incompatible-node",
        agents: [{ id: "seosoyoung", backend: "codex" }],
        supportedBackends: ["claude"],
      });

      const result = await requestCreateSession(harness, {
        prompt: "reject incompatible target",
        profile: "seosoyoung",
        nodeId: "z-incompatible-node",
      });

      expect(result.routedNodeId).toBeUndefined();
      expect(result.response.statusCode).toBe(409);
      expect(result.response.json()).toMatchObject({
        error: {
          code: "BACKEND_INCOMPATIBLE",
          nodeId: "z-incompatible-node",
        },
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it("chooses the least-loaded compatible node when nodeId is omitted", async () => {
    const harness = await createProductionHarness();
    try {
      const busyNode = await connectNode(harness, {
        nodeId: "a-busy-node",
        agents: [{ id: "seosoyoung", backend: "claude" }],
        supportedBackends: ["claude"],
      });
      await connectNode(harness, {
        nodeId: "z-idle-node",
        agents: [{ id: "seosoyoung", backend: "claude" }],
        supportedBackends: ["claude"],
      });
      busyNode.ws.send(JSON.stringify({
        type: "sessions_update",
        sessions: [{ agentSessionId: "existing-session", status: "running" }],
      }));
      await waitForSessionCount(harness, "a-busy-node", 1);

      const result = await requestCreateSession(harness, {
        prompt: "choose the idle node",
        profile: "seosoyoung",
      });

      expect(result.routedNodeId).toBe("z-idle-node");
      expect(result.response.statusCode).toBe(201);
    } finally {
      await closeHarness(harness);
    }
  });

  it("forwards the selected node's first compatible profile when profile is omitted", async () => {
    const harness = await createProductionHarness();
    try {
      await connectNode(harness, {
        nodeId: "node-a",
        agents: [
          { id: "first-compatible", backend: "claude" },
          { id: "second-compatible", backend: "claude" },
        ],
        supportedBackends: ["claude"],
      });

      const result = await requestCreateSession(harness, {
        prompt: "choose a default profile",
      });

      expect(result.routedNodeId).toBe("node-a");
      expect(result.command).toMatchObject({ profile: "first-compatible" });
      expect(result.response.statusCode).toBe(201);
    } finally {
      await closeHarness(harness);
    }
  });
});

async function createProductionHarness() {
  const sql = Object.assign(
    vi.fn(async () => []),
    { listen: vi.fn() },
  ) as unknown as LivePostgresSql;
  const sqlResolver: LiveDbSqlResolver = {
    resolveSql: vi.fn(async () => sql),
    close: vi.fn(async () => undefined),
  };
  const application = await createLiveProductionApplication(
    loadOrchServerEnvironment(minimalEnvironment()),
    { warn: vi.fn() },
    { sqlResolver },
  );
  await application.app.ready();
  return {
    application,
    authHeaders: {
      authorization: "Bearer production-service-token",
    },
    nodes: [] as RegisteredTestNode[],
  };
}

type ProductionHarness = Awaited<ReturnType<typeof createProductionHarness>>;

async function connectNode(
  harness: ProductionHarness,
  registration: {
    nodeId: string;
    agents: Array<{ id: string; backend: string }>;
    supportedBackends: string[];
  },
): Promise<RegisteredTestNode> {
  const ws = await (
    harness.application.app as typeof harness.application.app & WebSocketInjectableApp
  ).injectWS("/ws/node", { headers: harness.authHeaders });
  const node = { nodeId: registration.nodeId, ws };
  harness.nodes.push(node);
  ws.send(JSON.stringify({
    type: "node_register",
    node_id: registration.nodeId,
    agents: registration.agents,
    supported_backends: registration.supportedBackends,
    user: { email: "dashboard@example.com" },
  }));
  await waitForNode(harness, registration.nodeId);
  return node;
}

async function requestCreateSession(
  harness: ProductionHarness,
  payload: Record<string, unknown>,
): Promise<{
  response: Awaited<ReturnType<ProductionHarness["application"]["app"]["inject"]>>;
  routedNodeId?: string;
  command?: Record<string, unknown>;
}> {
  const responsePromise = harness.application.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: harness.authHeaders,
    payload,
  });
  const first = await Promise.race([
    responsePromise.then((response) => ({ kind: "response" as const, response })),
    waitForAnyMessageType(harness.nodes, "create_session").then((observed) => ({
      kind: "command" as const,
      ...observed,
    })),
  ]);
  if (first.kind === "response") return { response: first.response };

  const dispatchedSessionId = first.command.agentSessionId;
  first.node.ws.send(JSON.stringify({
    type: "session_created",
    requestId: first.command.requestId,
    agentSessionId:
      typeof dispatchedSessionId === "string"
        ? dispatchedSessionId
        : "legacy-node-generated-id",
  }));
  return {
    response: await responsePromise,
    routedNodeId: first.node.nodeId,
    command: first.command,
  };
}

async function waitForAnyMessageType(
  nodes: RegisteredTestNode[],
  expectedType: string,
): Promise<{ node: RegisteredTestNode; command: Record<string, unknown> }> {
  return Promise.race(
    nodes.map((node) =>
      waitForMessageType(node.ws, expectedType).then((command) => ({ node, command })),
    ),
  );
}

async function waitForMessageType(
  ws: TestWebSocket,
  expectedType: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      const decoded = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
      ) as Record<string, unknown>;
      if (decoded.type === expectedType) resolve(decoded);
    });
  });
}

async function waitForNode(
  harness: ProductionHarness,
  nodeId: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    const response = await harness.application.app.inject({
      method: "GET",
      url: "/api/nodes",
      headers: harness.authHeaders,
    });
    const body = response.json() as { nodes?: Array<{ nodeId?: string }> };
    if (body.nodes?.some((node) => node.nodeId === nodeId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Node registration timed out: ${nodeId}`);
}

async function waitForSessionCount(
  harness: ProductionHarness,
  nodeId: string,
  expectedCount: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    const response = await harness.application.app.inject({
      method: "GET",
      url: "/api/nodes",
      headers: harness.authHeaders,
    });
    const body = response.json() as {
      nodes?: Array<{ nodeId?: string; sessionCount?: number }>;
    };
    const node = body.nodes?.find((candidate) => candidate.nodeId === nodeId);
    if (node?.sessionCount === expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Session count did not reach ${expectedCount} for ${nodeId}`);
}

async function closeHarness(harness: ProductionHarness): Promise<void> {
  for (const node of harness.nodes) node.ws.terminate();
  await harness.application.app.close();
  await harness.application.closeResources();
}

function minimalEnvironment(): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    DATABASE_URL: "postgres://unused@localhost/unused",
    ENVIRONMENT: "production",
    CORS_ALLOWED_ORIGINS: "http://127.0.0.1",
    AUTH_BEARER_TOKEN: "production-service-token",
    BOARD_YJS_HOST_MODE: "orch",
    GOOGLE_CLIENT_ID: "dashboard-google-client",
    JWT_SECRET: "production-jwt-secret",
    CLAUDE_OAUTH_CLIENT_ID: "test-client",
    CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
  };
}
