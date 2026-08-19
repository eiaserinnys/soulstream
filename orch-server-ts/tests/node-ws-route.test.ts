import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  PerNodeSessionCache,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type NodeRegistryEvent,
} from "../src/index.js";
import type { EventAppendBatch } from "../src/node/event_ingress_types.js";

const explicitTestConfig = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type TestWebSocket = {
  close: () => void;
  send: (data: string) => void;
  terminate: () => void;
  on: {
    (event: "close", handler: (code: number, reason: Buffer) => void): void;
    (event: "message", handler: (data: string | Buffer | ArrayBuffer) => void): void;
  };
};

type WebSocketInjectableApp = {
  injectWS: (path: string, upgradeContext?: {
    headers?: Record<string, string>;
  }) => Promise<TestWebSocket>;
};

const productionConfig = parseOrchServerConfig({
  environment: "production",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "production-service-token",
});

describe("Node WS Fastify route harness", () => {
  const fixture = loadContractFixtures().fakeNodeReconnect;
  const releaseManifest = {
    schema_version: 1,
    manifest_id: "manifest-1",
    release_cohort_id: "cohort-1",
    source_commit: "commit-1",
    host_bundle_hash: "sha256-host",
    runner_release_id: "sha256-runner-release",
    runner_artifact_hash: "sha256-runner-artifact",
    schema_generation: "schema-70",
    wire_generation: "wire-1",
    node: { version: "v22.18.0", platform: "linux", arch: "x64" },
    deployment_env_identity: "sha256-env",
    executables: {
      claude: { kind: "claude", path: "/usr/bin/claude", identity: "sha256-claude" },
      codex: { kind: "codex", path: "/usr/bin/codex", identity: "sha256-codex" },
    },
  } as const;

  function createRegistry(nowMs = 1_700_000_000_000): {
    registry: InMemoryNodeRegistry;
    sessionCache: PerNodeSessionCache;
  } {
    const sessionCache = new PerNodeSessionCache();
    return {
      registry: new InMemoryNodeRegistry({
        sessionCache,
        nowMs: () => nowMs,
      }),
      sessionCache,
    };
  }

  it("does not expose /ws/node on the default app", async () => {
    const app = createApp({ config: explicitTestConfig });

    const response = await app.inject({ method: "GET", url: "/ws/node" });

    expect(response.statusCode).toBe(404);
    expect("injectWS" in app).toBe(false);

    await app.close();
  });

  it("rejects unauthenticated and invalid bearer handshakes before upgrade", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: productionConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const injectable = app as unknown as WebSocketInjectableApp;
    await expect(injectable.injectWS("/ws/node")).rejects.toThrow(
      "Unexpected server response: 401",
    );
    await expect(
      injectable.injectWS("/ws/node", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    ).rejects.toThrow("Unexpected server response: 403");
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("rejects production handshakes when AUTH_BEARER_TOKEN is not configured", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: parseOrchServerConfig({
        environment: "production",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        authBearerToken: "",
      }),
      nodeWsRoute: { registry },
    });

    await app.ready();
    await expect(
      (app as unknown as WebSocketInjectableApp).injectWS("/ws/node"),
    ).rejects.toThrow("Unexpected server response: 503");

    await app.close();
  });

  it("accepts a valid production bearer and registers the node", async () => {
    const { registry } = createRegistry();
    const resolveTokenAccess = vi.fn(async () => ({
      ok: false as const,
      statusCode: 401,
      detail: "HTTP auth should not own node WebSocket authentication",
    }));
    const app = createApp({
      config: productionConfig,
      productionAuth: { resolveTokenAccess },
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app, "production-service-token");
    const registrationAck = waitForMessage(ws);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    await expect(registrationAck).resolves.toSatisfy((value: unknown) => {
      if (typeof value !== "string") return false;
      const raw = value;
      const ack = JSON.parse(raw) as Record<string, unknown>;
      return ack.type === "node_register_ack"
        && ack.node_id === "fake-node"
        && typeof ack.connection_id === "string"
        && (ack.capabilities as Record<string, unknown>).runner_inventory_v1 === true
        && (ack.capabilities as Record<string, unknown>).control_channel_v1 === true;
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      nodeId: "fake-node",
      status: "connected",
    });
    expect(resolveTokenAccess).not.toHaveBeenCalled();

    ws.terminate();
    await app.close();
  });

  it("does not register or ACK a release-aware node before the activation receipt is durable", async () => {
    const { registry } = createRegistry();
    let resolvePersist!: (value: {
      manifest_id: string;
      activation_generation: number;
      activated_at: string;
      registration_idempotency_key: string;
    }) => void;
    const persist = vi.fn(async () => await new Promise<{
      manifest_id: string;
      activation_generation: number;
      activated_at: string;
      registration_idempotency_key: string;
    }>((resolve) => { resolvePersist = resolve; }));
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, releaseActivationReceipts: { persist } },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const registrationAck = waitForMessage(ws);
    ws.send(JSON.stringify({
      ...fixture.registration,
      release_manifest: releaseManifest,
      release_activation: {
        manifest_id: "manifest-1",
        release_cohort_id: "cohort-1",
        source_commit: "commit-1",
        prewarmed_at: "2026-08-19T09:00:00.000Z",
        verification: {
          host: "verified",
          runner: "verified",
          env: "verified",
          executable: "verified",
        },
        registration_idempotency_key: "registration-key",
      },
    }));

    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(registry.getConnectedNode("fake-node")).toBeUndefined();
    resolvePersist({
      manifest_id: "manifest-1",
      activation_generation: 7,
      activated_at: "2026-08-19T09:00:01.000Z",
      registration_idempotency_key: "registration-key",
    });
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    await expect(registrationAck).resolves.toSatisfy((value: unknown) => {
      const ack = JSON.parse(String(value)) as Record<string, unknown>;
      return (ack.release_activation_receipt as Record<string, unknown>)
        .activation_generation === 7;
    });

    ws.terminate();
    await app.close();
  });

  it("rejects an incomplete release manifest before receipt persistence", async () => {
    const { registry } = createRegistry();
    const persist = vi.fn();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, releaseActivationReceipts: { persist } },
    });
    const { runner_artifact_hash: _omitted, ...incompleteManifest } = releaseManifest;

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({
      ...fixture.registration,
      release_manifest: incompleteManifest,
      release_activation: {
        manifest_id: "manifest-1",
        release_cohort_id: "cohort-1",
        source_commit: "commit-1",
        prewarmed_at: "2026-08-19T09:00:00.000Z",
        verification: {
          host: "verified",
          runner: "verified",
          env: "verified",
          executable: "verified",
        },
        registration_idempotency_key: "registration-key",
      },
    }));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "release activation invalid",
    });
    expect(persist).not.toHaveBeenCalled();
    expect(registry.getConnectedNode("fake-node")).toBeUndefined();
    await app.close();
  });

  it("wires register, refresh, message relay, and close through a per-connection controller", async () => {
    const { registry, sessionCache } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const registered = registry.getConnectedNode("fake-node");

    expect(registered).toMatchObject({
      nodeId: "fake-node",
      status: "connected",
    });

    ws.send(
      JSON.stringify({
        type: "node_register",
        node_id: "fake-node",
        host: "10.0.0.2",
        port: 4305,
        agents: [{ id: "codex-agent", name: "Codex Agent", backend: "codex" }],
        capabilities: { app_heartbeat_v1: true },
        supported_backends: ["codex", "claude"],
        sessions: fixture.sessionsUpdateAfterReconnect.sessions,
      }),
    );
    await waitFor(
      () => registry.getConnectedNode("fake-node")?.host === "10.0.0.2",
    );

    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: registered?.connectionId,
      host: "10.0.0.2",
      port: 4305,
      supportedBackends: ["codex", "claude"],
    });
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      connectionId: registered?.connectionId,
      status: "running",
      fresh: true,
    });

    ws.send(JSON.stringify(fixture.eventRelay));
    await waitFor(() => sessionCache.findSession("sess-contract")?.lastEventId === 1);
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      fresh: true,
      lastEventId: 1,
    });

    ws.terminate();
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);
    expect(registry.getNodeState("fake-node")).toMatchObject({
      connectionId: registered?.connectionId,
      status: "disconnected",
    });

    await app.close();
  });

  it("keeps heartbeat responsive while event ingress is waiting on a commit", async () => {
    const { registry, sessionCache } = createRegistry();
    const eventSink = vi.fn();
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitBatch = vi.fn(async (_nodeId: string, batch: EventAppendBatch) => {
      await commitGate;
      return batch.events.map((envelope) => ({
        envelope,
        eventId: 73,
        duplicateReceipt: false,
      }));
    });
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: {
        registry,
        eventSink,
        eventIngress: { commitBatch },
      },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const registrationAck = waitForMessage(ws);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    await expect(registrationAck).resolves.toContain("node_register_ack");
    ws.send(JSON.stringify({
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10",
      first_seq: 1,
      events: [{
        stream_id: "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10",
        source_seq: 1,
        session_id: "sess-ingress",
        event_type: "assistant_message",
        payload: { type: "assistant_message", content: "committed" },
        searchable_text: "committed",
        created_at: "2026-08-06T00:00:00.000Z",
        semantic_dedupe_key: null,
        session_effect: null,
        payload_hash: "a".repeat(64),
      }],
    }));

    await waitFor(() => commitBatch.mock.calls.length === 1);
    const sentAt = "2026-08-13T00:00:00.000Z";
    const pong = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "app_heartbeat_ping", sentAt }));
    await expect(pong).resolves.toBe(
      JSON.stringify({ type: "app_heartbeat_pong", sentAt }),
    );
    const ackMessage = waitForMessage(ws);
    releaseCommit();

    await expect(ackMessage).resolves.toBe(JSON.stringify({
      type: "event_append_ack",
      stream_id: "018f47b7-c6de-7d64-9c8d-0b62cbbb2e10",
      acked_through: 1,
      events: [{ source_seq: 1, event_id: 73 }],
    }));
    expect(commitBatch).toHaveBeenCalledWith("fake-node", expect.objectContaining({ first_seq: 1 }));
    expect(sessionCache.findSession("sess-ingress")?.lastEventId).toBe(73);
    expect(eventSink.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ type: "node_session_event", nodeId: "fake-node" }),
    ]);

    ws.terminate();
    await app.close();
  });

  it("echoes the same sentAt in pong across two heartbeat windows", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const registrationAck = waitForMessage(ws);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    await expect(registrationAck).resolves.toContain("node_register_ack");

    for (const sentAt of ["2026-07-10T06:00:00.000Z", "2026-07-10T06:00:30.000Z"]) {
      const pong = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "app_heartbeat_ping", sentAt }));
      await expect(pong).resolves.toBe(
        JSON.stringify({ type: "app_heartbeat_pong", sentAt }),
      );
      expect(registry.getConnectedNode("fake-node")).toMatchObject({
        status: "connected",
        heartbeat: { lastPingAtMs: 1_700_000_000_000 },
      });
    }

    ws.terminate();
    await app.close();
  });

  it("closes an unregistered connection when the registration deadline expires", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, registrationTimeoutMs: 20 },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    await expect(waitForClose(ws)).resolves.toEqual({
      code: 4001,
      reason: "registration timeout",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("closes invalid JSON with an observable protocol error", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const closed = waitForClose(ws);
    ws.send("{not-json");

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: "invalid JSON frame",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("closes a non-node_register first frame with a policy violation", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "event" }));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "EXPECTED_NODE_REGISTER",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("attaches transport only after successful node_register and detaches the same connection on close", async () => {
    const { registry } = createRegistry();
    const transportHub = new NodeCommandTransportHub();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, transportHub },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);

    expect(transportHub.listAttached()).toEqual([]);

    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const connectionId = requireDefined(
      registry.getConnectedNode("fake-node")?.connectionId,
    );

    expect(transportHub.has({ nodeId: "fake-node", connectionId })).toBe(true);

    ws.terminate();
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);
    expect(transportHub.has({ nodeId: "fake-node", connectionId })).toBe(false);

    await app.close();
  });

  it("activates a separately registered control lane and falls back to data when it closes", async () => {
    const { registry } = createRegistry();
    const transportHub = new NodeCommandTransportHub();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, transportHub },
    });

    await app.ready();
    const dataWs = await injectAuthenticatedWs(app);
    const registrationAck = waitForMessage(dataWs);
    dataWs.send(JSON.stringify({
      ...fixture.registration,
      capabilities: {
        ...((fixture.registration as Record<string, unknown>).capabilities as
          Record<string, unknown> | undefined ?? {}),
        control_channel_v1: true,
      },
    }));
    const dataAck = JSON.parse(await registrationAck) as Record<string, unknown>;
    const connectionId = requireDefined(dataAck.connection_id as string | undefined);

    const controlWs = await injectAuthenticatedWs(app, "test-token", "/ws/node/control");
    const controlRegistrationAck = waitForMessage(controlWs);
    controlWs.send(JSON.stringify({
      type: "node_control_register",
      node_id: "fake-node",
      connection_id: connectionId,
    }));
    await expect(controlRegistrationAck).resolves.toBe(JSON.stringify({
      type: "node_control_register_ack",
      node_id: "fake-node",
      connection_id: connectionId,
    }));

    const controlReadyAck = waitForMessage(controlWs);
    controlWs.send(JSON.stringify({ type: "node_control_ready" }));
    await expect(controlReadyAck).resolves.toBe(JSON.stringify({
      type: "node_control_ready_ack",
    }));
    await waitFor(() => transportHub.has({ nodeId: "fake-node", connectionId }));

    const pending = registry.createCommand("fake-node", {
      type: "intervene",
      agentSessionId: "session-a",
      text: "stop",
    });
    const controlCommand = waitForMessage(controlWs);
    await transportHub.get({ nodeId: "fake-node", connectionId })?.send(
      JSON.stringify(pending.message),
    );
    await expect(controlCommand).resolves.toBe(JSON.stringify(pending.message));

    const receiveNodeMessage = vi.spyOn(registry, "receiveNodeMessage");
    controlWs.send(JSON.stringify({
      type: "control_admission_ack",
      requestId: pending.requestId,
      commandType: "intervene",
      commandFamily: "intervention",
      status: "accepted",
      durability: "control_inbox_sqlite",
    }));
    await waitFor(() => receiveNodeMessage.mock.calls.some(([, message]) =>
      message.type === "control_admission_ack"));
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 1,
    });

    const resultAck = waitForMessage(controlWs);
    controlWs.send(JSON.stringify({
      type: "control_result",
      resultId: "result-1",
      nodeId: "fake-node",
      commandFamily: "intervention",
      requestId: pending.requestId,
      state: "completed",
      response: {
        type: "intervene_ack",
        requestId: pending.requestId,
        status: "ok",
      },
    }));
    await expect(resultAck).resolves.toBe(JSON.stringify({
      type: "control_result_ack",
      resultId: "result-1",
    }));
    await expect(pending.result).resolves.toMatchObject({
      type: "intervene_ack",
      requestId: pending.requestId,
      status: "ok",
    });

    controlWs.send(JSON.stringify({
      type: "control_ack_metric",
      nodeId: "fake-node",
      commandFamily: "intervention",
      windowMs: 5 * 60_000,
      sampleCount: 20,
      p99Ms: 42,
      maxMs: 64,
      p99GateMs: 250,
      maxGateMs: 1_000,
      withinGate: true,
    }));
    await waitFor(() =>
      registry.getConnectedNode("fake-node")?.controlAckMetrics.intervention
        ?.sampleCount === 20);
    expect(
      registry.getConnectedNode("fake-node")?.controlAckMetrics.intervention,
    ).toMatchObject({ windowMs: 5 * 60_000, p99Ms: 42, maxMs: 64, withinGate: true });

    controlWs.terminate();
    await delay(20);
    const dataProbe = waitForMessage(dataWs);
    await transportHub.get({ nodeId: "fake-node", connectionId })?.send("data-probe");
    await expect(dataProbe).resolves.toBe("data-probe");

    dataWs.terminate();
    await app.close();
  });

  it("closes without acknowledging a malformed durable result", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, transportHub: new NodeCommandTransportHub() },
    });

    await app.ready();
    const dataWs = await injectAuthenticatedWs(app);
    const registrationAck = waitForMessage(dataWs);
    dataWs.send(JSON.stringify({
      ...fixture.registration,
      capabilities: {
        ...((fixture.registration as Record<string, unknown>).capabilities as
          Record<string, unknown> | undefined ?? {}),
        control_channel_v1: true,
      },
    }));
    const dataAck = JSON.parse(await registrationAck) as Record<string, unknown>;
    const connectionId = requireDefined(dataAck.connection_id as string | undefined);
    const controlWs = await injectAuthenticatedWs(app, "test-token", "/ws/node/control");
    const controlRegistrationAck = waitForMessage(controlWs);
    controlWs.send(JSON.stringify({
      type: "node_control_register",
      node_id: "fake-node",
      connection_id: connectionId,
    }));
    await controlRegistrationAck;

    const closed = waitForClose(controlWs);
    controlWs.send(JSON.stringify({
      type: "control_result",
      resultId: "result-malformed",
      nodeId: "fake-node",
      commandFamily: "intervention",
      requestId: "req-1",
      state: "completed",
      response: { type: "intervene_ack", requestId: "different-request" },
    }));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "INVALID_CONTROL_RESULT",
    });
    dataWs.terminate();
    await app.close();
  });

  it("cleans registry and transport once when socket close is followed by app shutdown", async () => {
    const { registry } = createRegistry();
    const disconnectNode = vi.spyOn(registry, "disconnectNode");
    const transportHub = new NodeCommandTransportHub();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, transportHub },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);

    ws.terminate();
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);
    await app.close();

    expect(disconnectNode).toHaveBeenCalledTimes(1);
    expect(transportHub.listAttached()).toEqual([]);
  });

  it("closes unsupported non-object JSON payloads instead of dropping them", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify(["node_register"]));

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: "unsupported JSON frame",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("keeps stale route connection messages and close events from touching the current connection", async () => {
    const { registry, sessionCache } = createRegistry();
    const transportHub = new NodeCommandTransportHub();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, transportHub },
    });

    await app.ready();
    const oldWs = await injectAuthenticatedWs(app);
    oldWs.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const firstConnectionId = requireDefined(
      registry.getConnectedNode("fake-node")?.connectionId,
    );

    const currentWs = await injectAuthenticatedWs(app);
    currentWs.send(JSON.stringify(fixture.registration));
    await waitFor(
      () =>
        registry.getConnectedNode("fake-node")?.connectionId !==
        firstConnectionId,
    );
    const currentConnectionId = requireDefined(
      registry.getConnectedNode("fake-node")?.connectionId,
    );

    expect(
      transportHub.has({ nodeId: "fake-node", connectionId: currentConnectionId }),
    ).toBe(true);
    expect(
      transportHub.has({ nodeId: "fake-node", connectionId: firstConnectionId }),
    ).toBe(false);

    oldWs.send(JSON.stringify(fixture.eventRelay));
    await delay(20);
    expect(sessionCache.findSession("sess-contract")).toBeUndefined();

    oldWs.terminate();
    await delay(20);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: currentConnectionId,
      status: "connected",
    });
    expect(
      transportHub.has({ nodeId: "fake-node", connectionId: currentConnectionId }),
    ).toBe(true);

    currentWs.terminate();
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);
    expect(
      transportHub.has({ nodeId: "fake-node", connectionId: currentConnectionId }),
    ).toBe(false);

    await app.close();
  });

  it("passes frame events to an optional sink without letting sink failures break the route", async () => {
    const { registry, sessionCache } = createRegistry();
    const eventSink = vi.fn((events: NodeRegistryEvent[]): void => {
      expect(events.length).toBeGreaterThan(0);
      throw new Error("sink failure");
    });
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, eventSink },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);

    ws.send(JSON.stringify(fixture.eventRelay));
    await waitFor(() => sessionCache.findSession("sess-contract")?.lastEventId === 1);

    expect(eventSink).toHaveBeenCalledTimes(2);
    expect(eventSink.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "node_registered", nodeId: "fake-node" }),
      ]),
    );
    expect(eventSink.mock.calls[1]?.[0]).toEqual([
      {
        type: "node_session_event",
        nodeId: "fake-node",
        data: fixture.eventRelay,
      },
    ]);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      nodeId: "fake-node",
      status: "connected",
    });

    ws.terminate();
    await app.close();
  });
});

function waitForClose(ws: TestWebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function waitForMessage(ws: TestWebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      resolve(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    });
  });
}

function injectAuthenticatedWs(
  app: unknown,
  token = "test-token",
  path = "/ws/node",
): Promise<TestWebSocket> {
  return (app as WebSocketInjectableApp).injectWS(path, {
    headers: { authorization: `Bearer ${token}` },
  });
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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function requireDefined<TValue>(value: TValue | undefined): TValue {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}
