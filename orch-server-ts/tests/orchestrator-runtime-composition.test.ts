import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createOrchestratorRuntimeComposition,
  loadContractFixtures,
  parseOrchServerConfig,
  type BoardYjsHostHttpClient,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type TestWebSocket = {
  close: () => void;
  send: (data: string) => void;
  terminate: () => void;
  on: (
    event: "message",
    handler: (data: string | Buffer | ArrayBuffer) => void,
  ) => void;
};

type WebSocketInjectableApp = {
  injectWS: (path: string) => Promise<TestWebSocket>;
};

describe("orchestrator runtime composition harness", () => {
  const fixtures = loadContractFixtures();
  const reconnect = fixtures.fakeNodeReconnect;

  it("keeps default createApp free of opt-in runtime routes", async () => {
    const app = createApp({ config });

    expect(await app.inject({ method: "GET", url: "/ws/node" })).toMatchObject({
      statusCode: 404,
    });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { prompt: "hello" },
      }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({ method: "GET", url: "/api/sessions/stream" }),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/markdown-documents",
        payload: { folderId: "f1", title: "Note", body: "Body" },
      }),
    ).toMatchObject({ statusCode: 404 });
    expect("injectWS" in app).toBe(false);

    await app.close();
  });

  it("shares node websocket registration, transport, and session command routing", async () => {
    const runtime = createOrchestratorRuntimeComposition({
      config,
      nowMs: () => 1_700_000_000_000,
      requestIdGenerator: ({ sequence, commandType }) =>
        `runtime-${commandType}-${sequence}`,
      commandTimeoutMs: 1_000,
      loadSessionSnapshot: async () => ({ sessions: [] }),
      loadTaskSnapshot: async () => ({ tasks: [] }),
      boardYjsHostHttpClient: vi.fn(),
      sseReplayOnlyForTests: true,
    });

    await runtime.app.ready();
    const ws = await (runtime.app as unknown as WebSocketInjectableApp).injectWS(
      "/ws/node",
    );
    ws.send(JSON.stringify(reconnect.registration));
    await waitFor(() => runtime.registry.getConnectedNode("fake-node") !== undefined);
    const connectionId = requireDefined(
      runtime.registry.getConnectedNode("fake-node")?.connectionId,
    );
    expect(runtime.transports.has({ nodeId: "fake-node", connectionId })).toBe(true);

    const commandMessage = waitForMessage(ws);
    const responsePromise = runtime.app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { prompt: "hello", folderId: "folder-1" },
    });
    const command = JSON.parse(await commandMessage) as Record<string, unknown>;
    expect(command).toMatchObject({
      type: "create_session",
      requestId: "runtime-create_session-1",
      prompt: "hello",
      folderId: "folder-1",
    });

    ws.send(
      JSON.stringify({
        type: "session_created",
        requestId: command.requestId,
        agentSessionId: "runtime-session",
      }),
    );
    const response = await responsePromise;

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      agentSessionId: "runtime-session",
      nodeId: "fake-node",
    });
    expect(runtime.registry.findSessionOwner("runtime-session")).toMatchObject({
      nodeId: "fake-node",
      connectionId,
      fresh: true,
      connected: true,
    });
    expect(runtime.sessionBroadcaster.latestEventId).toBe(0);

    ws.terminate();
    await runtime.app.close();
  });

  it("bridges direct websocket session updates into the session SSE replay broadcaster", async () => {
    const runtime = createOrchestratorRuntimeComposition({
      config,
      sessionSseInstanceId: "runtime-session-stream",
      loadSessionSnapshot: async () => ({ sessions: [] }),
      loadTaskSnapshot: async () => ({ tasks: [] }),
      boardYjsHostHttpClient: vi.fn(),
      sseReplayOnlyForTests: true,
    });

    await runtime.app.ready();
    const ws = await (runtime.app as unknown as WebSocketInjectableApp).injectWS(
      "/ws/node",
    );
    ws.send(JSON.stringify(reconnect.registration));
    await waitFor(() => runtime.registry.getConnectedNode("fake-node") !== undefined);

    ws.send(
      JSON.stringify({
        type: "session_updated",
        agentSessionId: "runtime-direct-session",
        status: "running",
      }),
    );
    await waitFor(() => runtime.sessionBroadcaster.latestEventId === 1);

    const replayResponse = await runtime.app.inject({
      method: "GET",
      url: "/api/sessions/stream?lastEventId=0&instanceId=runtime-session-stream",
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.body).toBe(
      'event: stream_meta\n' +
        'data: {"type":"stream_meta","instance_id":"runtime-session-stream","latest_id":1}\n\n' +
        "event: session_updated\n" +
        "id: 1\n" +
        'data: {"type":"session_updated","agentSessionId":"runtime-direct-session","status":"running","agent_session_id":"runtime-direct-session","nodeId":"fake-node"}\n\n',
    );
    expect(runtime.registry.findSessionOwner("runtime-direct-session")).toMatchObject({
      nodeId: "fake-node",
      fresh: true,
      connected: true,
    });

    ws.terminate();
    await runtime.app.close();
  });

  it("shares board host registration with the board proxy route and injectable client", async () => {
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => ({
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: { document: { id: "doc-runtime" } },
    }));
    const runtime = createOrchestratorRuntimeComposition({
      config,
      nowMs: () => 1_700_000_000_000,
      loadSessionSnapshot: async () => ({ sessions: [] }),
      loadTaskSnapshot: async () => ({ tasks: [] }),
      boardYjsHostHttpClient: httpClient,
      sseReplayOnlyForTests: true,
    });

    await runtime.app.ready();
    const ws = await (runtime.app as unknown as WebSocketInjectableApp).injectWS(
      "/ws/node",
    );
    ws.send(
      JSON.stringify({
        type: "node_register",
        node_id: "board-host",
        host: "127.0.0.1",
        port: 4105,
        agents: [],
        capabilities: { board_yjs_host: true },
      }),
    );
    await waitFor(() => runtime.registry.getConnectedNode("board-host") !== undefined);
    const connectionId = requireDefined(
      runtime.registry.getConnectedNode("board-host")?.connectionId,
    );

    const response = await runtime.app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      headers: { authorization: "Bearer test-token" },
      payload: { folderId: "f1", title: "Note", body: "Body" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ document: { id: "doc-runtime" } });
    expect(httpClient).toHaveBeenCalledWith({
      method: "POST",
      url: "http://127.0.0.1:4105/api/markdown-documents",
      upstreamPath: "/api/markdown-documents",
      headers: { authorization: "Bearer test-token" },
      body: { folderId: "f1", title: "Note", body: "Body" },
      target: {
        host: "127.0.0.1",
        port: 4105,
        nodeId: "board-host",
        connectionId,
      },
    });

    ws.terminate();
    await runtime.app.close();
  });

  it("shares SSE broadcasters and injectable snapshot loaders with the SSE routes", async () => {
    const loadSessionSnapshot = vi.fn(async () => ({
      sessions: [{ agent_session_id: "snapshot-session", title: "Snapshot" }],
      total: 1,
    }));
    const runtime = createOrchestratorRuntimeComposition({
      config,
      sessionSseInstanceId: "runtime-session-stream",
      taskSseInstanceId: "runtime-task-stream",
      loadSessionSnapshot,
      loadTaskSnapshot: async () => ({ tasks: [] }),
      boardYjsHostHttpClient: vi.fn(),
      sseReplayOnlyForTests: true,
    });
    runtime.sessionBroadcaster.append({
      type: "session_updated",
      agent_session_id: "runtime-session",
    });

    const snapshotResponse = await runtime.app.inject({
      method: "GET",
      url: "/api/sessions/stream",
    });
    const replayResponse = await runtime.app.inject({
      method: "GET",
      url: "/api/sessions/stream?lastEventId=0&instanceId=runtime-session-stream",
    });

    expect(snapshotResponse.statusCode).toBe(200);
    expect(snapshotResponse.body).toContain(
      'event: session_list\n' +
        'data: {"type":"session_list","sessions":[{"agent_session_id":"snapshot-session","title":"Snapshot"}],"total":1}\n\n',
    );
    expect(loadSessionSnapshot).toHaveBeenCalledTimes(1);

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.body).toBe(
      'event: stream_meta\n' +
        'data: {"type":"stream_meta","instance_id":"runtime-session-stream","latest_id":1}\n\n' +
        "event: session_updated\n" +
        "id: 1\n" +
        'data: {"type":"session_updated","agent_session_id":"runtime-session"}\n\n',
    );

    await runtime.app.close();
  });
});

function waitForMessage(ws: TestWebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      resolve(payloadToText(data));
    });
  });
}

function payloadToText(data: string | Buffer | ArrayBuffer): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("condition was not met before timeout");
    }
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireDefined<TValue>(value: TValue | undefined): TValue {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}
