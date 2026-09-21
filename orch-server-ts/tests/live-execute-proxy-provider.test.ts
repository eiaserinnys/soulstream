import { describe, expect, it, vi } from "vitest";

import {
  ExecuteProxyRouteError,
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  RuntimeSessionEventHub,
  SessionCommandRouter,
  SessionCommandTransportBridge,
  createLiveExecuteProxyRouteProvider,
  type ExecuteProxyResult,
} from "../src/index.js";
import {
  ModelPresetAvailabilityError,
  type ModelPresetAvailabilityService,
} from "../src/model/model_preset_availability.js";

describe("live execute proxy provider", () => {
  it("creates new execute sessions over the websocket command bridge and streams raw events", async () => {
    const harness = createHarness();
    const connectionId = harness.registerNode({
      nodeId: "node-codex",
      agents: [{ id: "codex-agent", backend: "codex" }],
      supportedBackends: ["codex"],
    });
    const sent = harness.attachTransport("node-codex", connectionId, (message) => {
      harness.receive("node-codex", connectionId, {
        type: "session_created",
        requestId: message.requestId,
        agentSessionId: message.agentSessionId,
      });
      harness.receive("node-codex", connectionId, {
        type: "event",
        agentSessionId: message.agentSessionId,
        event: { type: "complete", result: "done", _event_id: 7 },
      });
      harness.receive("node-codex", connectionId, {
        type: "event",
        agentSessionId: message.agentSessionId,
        event: { type: "thinking", content: "after", _event_id: 8 },
      });
    });

    const result = await harness.provider.executeNew({
      prompt: "hello",
      profile: "codex-agent",
      folderId: "folder-a",
      system_prompt: "system",
      model: "gpt-5",
      reasoningEffort: "high",
      allowed_tools: ["Read"],
      disallowed_tools: ["Write"],
      claude_permission_mode: "acceptEdits",
      use_mcp: true,
      caller_info: { source: "execute-proxy" },
      extra_context_items: [{ key: "k", content: "v" }],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "create_session",
      requestId: "cmd-create_session-1-1700000000000",
      agentSessionId: "generated-session",
      prompt: "hello",
      profile: "codex-agent",
      folderId: "folder-a",
      systemPrompt: "system",
      model: "gpt-5",
      reasoningEffort: "high",
      allowed_tools: ["Read"],
      disallowed_tools: ["Write"],
      claude_permission_mode: "acceptEdits",
      use_mcp: true,
      caller_info: { source: "execute-proxy" },
      extra_context_items: [{ key: "k", content: "v" }],
    });
    expect(sent[0]).not.toHaveProperty("url");
    await expect(resultBody(result)).resolves.toBe(
      'event: init\n' +
        'data: {"type":"init","agent_session_id":"generated-session","node_id":"node-codex"}\n\n' +
        'event: complete\n' +
        'id: 7\n' +
        'data: {"type":"complete","result":"done","_event_id":7}\n\n',
    );
  });

  it("resumes existing execute sessions through intervene and preserves attachment/context payloads", async () => {
    const harness = createHarness();
    const connectionId = harness.registerNode({
      nodeId: "node-a",
      agents: [{ id: "claude-agent", backend: "claude" }],
      supportedBackends: ["claude"],
    });
    harness.registry.sessionCache.upsertFromSessionCreated({
      nodeId: "node-a",
      connectionId,
      message: {
        type: "session_created",
        session: { agent_session_id: "sess-existing", status: "running" },
      },
      nowMs: 1_700_000_000_000,
    });
    const sent = harness.attachTransport("node-a", connectionId, (message) => {
      harness.receive("node-a", connectionId, {
        type: "intervene_ack",
        requestId: message.requestId,
        status: "ok",
        outcome: "queued",
      });
      harness.receive("node-a", connectionId, {
        type: "event",
        agentSessionId: "sess-existing",
        payload: { type: "complete", result: "resumed" },
        eventId: 11,
      });
    });

    const result = await harness.provider.executeResume({
      agent_session_id: "sess-existing",
      prompt: "continue",
      attachment_paths: ["uploads/a.png"],
      caller_info: { source: "slack" },
      extra_context_items: [{ key: "ctx" }],
      delivery_id: "delivery-1",
      delivery_intent: "runtime_followup",
      source: "execute-proxy",
      relation_key: "runtime_task:task-1:done",
      delivery_attempt_token: "runtime:node-a",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "intervene",
      requestId: "cmd-intervene-1-1700000000000",
      agentSessionId: "sess-existing",
      text: "continue",
      user: "",
      attachment_paths: ["uploads/a.png"],
      caller_info: { source: "slack" },
      extra_context_items: [{ key: "ctx" }],
      delivery_id: "delivery-1",
      delivery_intent: "runtime_followup",
      source: "execute-proxy",
      relation_key: "runtime_task:task-1:done",
      delivery_attempt_token: "runtime:node-a",
    });
    await expect(resultBody(result)).resolves.toBe(
      'event: init\n' +
        'data: {"type":"init","agent_session_id":"sess-existing","node_id":"node-a"}\n\n' +
        'event: complete\n' +
        'id: 11\n' +
        'data: {"type":"complete","result":"resumed"}\n\n',
    );
  });

  it("selects a Codex preset for a base Claude profile and forwards both explicit fields", async () => {
    const requireAvailable = vi.fn(() => ({
      id: "codex-5.6-sol",
      label: "Codex - 5.6 Sol",
      backend: "codex" as const,
      available: true,
      reason: null,
      reason_label: null,
      resets_at: null,
      usage_warning: false,
    }));
    const harness = createHarness({
      modelPresetAvailability: { requireAvailable },
    });
    const connectionId = harness.registerNode({
      nodeId: "node-hybrid",
      agents: [{ id: "base-agent", backend: "claude" }],
      supportedBackends: ["claude", "codex"],
      modelPresets: [{
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: true,
        usage_provider: "codex",
      }],
    });
    const sent = harness.attachTransport("node-hybrid", connectionId, (message) => {
      harness.receive("node-hybrid", connectionId, {
        type: "session_created",
        requestId: message.requestId,
        agentSessionId: message.agentSessionId,
      });
      harness.receive("node-hybrid", connectionId, {
        type: "event",
        agentSessionId: message.agentSessionId,
        event: { type: "complete", result: "done", _event_id: 12 },
      });
    });

    const result = await harness.provider.executeNew({
      prompt: "hello",
      profile: "base-agent",
      model: "literal-model-is-worker-fallback-only",
      model_preset: "codex-5.6-sol",
      caller_info: { source: "execute-proxy" },
    });

    expect(requireAvailable).toHaveBeenCalledWith("node-hybrid", "codex-5.6-sol");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "create_session",
      profile: "base-agent",
      model: "literal-model-is-worker-fallback-only",
      model_preset: "codex-5.6-sol",
    });
    await expect(resultBody(result)).resolves.toContain('"node_id":"node-hybrid"');
  });

  it("closes a new execute stream when a session error update arrives", async () => {
    const harness = createHarness();
    const connectionId = harness.registerNode({
      nodeId: "node-codex",
      agents: [{ id: "codex-agent", backend: "codex" }],
      supportedBackends: ["codex"],
    });
    harness.attachTransport("node-codex", connectionId, (message) => {
      harness.receive("node-codex", connectionId, {
        type: "session_created",
        requestId: message.requestId,
        agentSessionId: message.agentSessionId,
      });
      harness.receive("node-codex", connectionId, {
        type: "session_updated",
        session: {
          agent_session_id: "generated-session",
          status: "error",
          terminationReason: "error_aborted",
          terminationDetail: "Codex app-server request timed out after 30000ms: initialize",
        },
      });
    });

    const result = await harness.provider.executeNew({
      prompt: "hello",
      profile: "codex-agent",
      caller_info: { source: "execute-proxy" },
    });

    await expect(resultBody(result)).resolves.toBe(
      'event: init\n' +
        'data: {"type":"init","agent_session_id":"generated-session","node_id":"node-codex"}\n\n' +
        'event: error\n' +
        'data: {"type":"error","code":"error_aborted","message":"Codex app-server request timed out after 30000ms: initialize"}\n\n',
    );
  });

  it("keeps a legacy model override from selecting the profile default preset", async () => {
    const requireAvailable = vi.fn();
    const harness = createHarness({
      modelPresetAvailability: { requireAvailable },
    });
    const connectionId = harness.registerNode({
      nodeId: "node-hybrid",
      agents: [{
        id: "defaulted-agent",
        backend: "claude",
        default_preset: "codex-5.6-sol",
      }],
      supportedBackends: ["claude", "codex"],
      modelPresets: [{
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: true,
        usage_provider: "codex",
      }],
    });
    const sent = harness.attachTransport("node-hybrid", connectionId, (message) => {
      harness.receive("node-hybrid", connectionId, {
        type: "session_created",
        requestId: message.requestId,
        agentSessionId: message.agentSessionId,
      });
      harness.receive("node-hybrid", connectionId, {
        type: "event",
        agentSessionId: message.agentSessionId,
        event: { type: "complete", result: "done", _event_id: 13 },
      });
    });

    const result = await harness.provider.executeNew({
      prompt: "hello",
      profile: "defaulted-agent",
      model: "legacy-model",
      caller_info: { source: "execute-proxy" },
    });

    expect(requireAvailable).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ model: "legacy-model" });
    expect(sent[0]).not.toHaveProperty("model_preset");
    await expect(resultBody(result)).resolves.toContain('"node_id":"node-hybrid"');
  });

  it.each(["", "   "])(
    "treats blank model %j as unset before checking the profile default preset",
    async (model) => {
      const requireAvailable = vi.fn(() => {
        throw new ModelPresetAvailabilityError(
          "MODEL_PRESET_UNAVAILABLE",
          "Model preset 'codex-5.6-sol' is unavailable on node node-hybrid: 미인증",
        );
      });
      const harness = createHarness({
        modelPresetAvailability: { requireAvailable },
      });
      const connectionId = harness.registerNode({
        nodeId: "node-hybrid",
        agents: [{
          id: "defaulted-agent",
          backend: "claude",
          default_preset: "codex-5.6-sol",
        }],
        supportedBackends: ["claude", "codex"],
        modelPresets: [{
          id: "codex-5.6-sol",
          label: "Codex - 5.6 Sol",
          backend: "codex",
          available: true,
          usage_provider: "codex",
        }],
      });
      const sent = harness.attachTransport("node-hybrid", connectionId);

      await expect(harness.provider.executeNew({
        prompt: "hello",
        profile: "defaulted-agent",
        model,
        caller_info: { source: "execute-proxy" },
      })).rejects.toMatchObject({
        statusCode: 400,
        detail: {
          error: {
            code: "MODEL_PRESET_UNAVAILABLE",
            message: expect.stringContaining("미인증"),
          },
        },
      });
      expect(requireAvailable).toHaveBeenCalledWith("node-hybrid", "codex-5.6-sol");
      expect(sent).toEqual([]);
    },
  );

  it.each([
    ["unavailable", "키 미설정"],
    ["not authenticated", "미인증"],
    ["quota exhausted", "7일 사용량 제한"],
  ])("blocks %s presets before sending a command", async (_case, reason) => {
    const requireAvailable = vi.fn(() => {
      throw new ModelPresetAvailabilityError(
        "MODEL_PRESET_UNAVAILABLE",
        `Model preset 'codex-5.6-sol' is unavailable on node node-hybrid: ${reason}`,
      );
    });
    const harness = createHarness({
      modelPresetAvailability: { requireAvailable },
    });
    const connectionId = harness.registerNode({
      nodeId: "node-hybrid",
      agents: [{ id: "base-agent", backend: "claude" }],
      supportedBackends: ["claude", "codex"],
      modelPresets: [{
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: true,
        usage_provider: "codex",
      }],
    });
    const sent = harness.attachTransport("node-hybrid", connectionId);

    await expect(harness.provider.executeNew({
      prompt: "hello",
      profile: "base-agent",
      model_preset: "codex-5.6-sol",
      caller_info: { source: "execute-proxy" },
    })).rejects.toMatchObject({
      statusCode: 400,
      detail: {
        error: {
          code: "MODEL_PRESET_UNAVAILABLE",
          message: expect.stringContaining(reason),
        },
      },
    });
    expect(sent).toEqual([]);
  });

  it("maps unavailable execute targets to route errors before sending commands", async () => {
    const harness = createHarness();

    await expect(
      harness.provider.executeNew({
        prompt: "hello",
        profile: "missing-agent",
        caller_info: { source: "execute-proxy" },
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      detail: "No nodes available",
    });

    const connectionId = harness.registerNode({
      nodeId: "node-claude",
      agents: [{ id: "claude-agent", backend: "claude" }],
      supportedBackends: ["claude"],
    });
    const sent = harness.attachTransport("node-claude", connectionId);

    await expect(
      harness.provider.executeNew({
        prompt: "hello",
        nodeId: "node-claude",
        profile: "missing-agent",
        caller_info: { source: "execute-proxy" },
      }),
    ).rejects.toBeInstanceOf(ExecuteProxyRouteError);
    expect(sent).toEqual([]);
  });

  it("returns the already-subscribed stream when a timed-out create is durably registered", async () => {
    const findRescuableSessionOwnerNodeId = vi.fn(async () => "node-codex");
    const harness = createHarness({
      timeoutMs: 1,
      createSessionReconcileTimeoutMs: 50,
      findRescuableSessionOwnerNodeId,
    });
    const connectionId = harness.registerNode({
      nodeId: "node-codex",
      agents: [{ id: "codex-agent", backend: "codex" }],
      supportedBackends: ["codex"],
    });
    const sent = harness.attachTransport("node-codex", connectionId);

    const result = await harness.provider.executeNew({
      prompt: "hello",
      profile: "codex-agent",
      caller_info: { source: "execute-proxy" },
    });
    expect(sent).toHaveLength(1);
    expect(findRescuableSessionOwnerNodeId).toHaveBeenCalledWith("generated-session");

    harness.receive("node-codex", connectionId, {
      type: "event",
      agentSessionId: "generated-session",
      event: { type: "complete", result: "rescued", _event_id: 17 },
    });
    await expect(resultBody(result)).resolves.toBe(
      'event: init\n' +
        'data: {"type":"init","agent_session_id":"generated-session","node_id":"node-codex"}\n\n' +
        'event: complete\n' +
        'id: 17\n' +
        'data: {"type":"complete","result":"rescued","_event_id":17}\n\n',
    );
  });

  it("keeps NODE_COMMAND_TIMEOUT when durable registration is absent or on another node", async () => {
    for (const durableOwner of [null, "other-node"] as const) {
      const harness = createHarness({
        timeoutMs: 1,
        createSessionReconcileTimeoutMs: 1,
        findRescuableSessionOwnerNodeId: async () => durableOwner,
      });
      const connectionId = harness.registerNode({
        nodeId: "node-codex",
        agents: [{ id: "codex-agent", backend: "codex" }],
        supportedBackends: ["codex"],
      });
      harness.attachTransport("node-codex", connectionId);

      await expect(harness.provider.executeNew({
        prompt: "hello",
        profile: "codex-agent",
        caller_info: { source: "execute-proxy" },
      })).rejects.toMatchObject({
        statusCode: 503,
        detail: {
          error: { code: "NODE_COMMAND_TIMEOUT" },
        },
      });
    }
  });

  it("bounds a stalled DB rescue and unsubscribes the abandoned stream", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        timeoutMs: 30_000,
        createSessionReconcileTimeoutMs: 5_000,
        findRescuableSessionOwnerNodeId: async () =>
          await new Promise<string | null>(() => undefined),
      });
      const unsubscribe = observeUnsubscribe(harness.sessionEventHub);
      const connectionId = harness.registerNode({
        nodeId: "node-codex",
        agents: [{ id: "codex-agent", backend: "codex" }],
        supportedBackends: ["codex"],
      });
      harness.attachTransport("node-codex", connectionId);

      const outcome = Promise.resolve(
        harness.provider.executeNew({
          prompt: "hello",
          profile: "codex-agent",
          caller_info: { source: "execute-proxy" },
        }),
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(34_999);
      expect(unsubscribe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toMatchObject({
        statusCode: 503,
        detail: { error: { code: "NODE_COMMAND_TIMEOUT" } },
      });
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rescue an owner-only initializing row when metadata failure ACK is late", async () => {
    vi.useFakeTimers();
    try {
      const findSessionOwnerNodeId = vi.fn(async () => "node-codex");
      const findRescuableSessionOwnerNodeId = vi.fn(async () => null);
      const harness = createHarness({
        timeoutMs: 30_000,
        createSessionReconcileTimeoutMs: 5_000,
        findSessionOwnerNodeId,
        findRescuableSessionOwnerNodeId,
      });
      const unsubscribe = observeUnsubscribe(harness.sessionEventHub);
      const connectionId = harness.registerNode({
        nodeId: "node-codex",
        agents: [{ id: "codex-agent", backend: "codex" }],
        supportedBackends: ["codex"],
      });
      harness.attachTransport("node-codex", connectionId, (message) => {
        setTimeout(() => {
          harness.receive("node-codex", connectionId, {
            type: "error",
            requestId: message.requestId,
            command_type: "create_session",
            message: "Handler error: metadata durability failed",
          });
        }, 30_001);
      });

      const outcome = Promise.resolve(
        harness.provider.executeNew({
          prompt: "hello",
          profile: "codex-agent",
          caller_info: { source: "execute-proxy" },
        }),
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(35_000);

      await expect(outcome).resolves.toMatchObject({
        statusCode: 503,
        detail: { error: { code: "NODE_COMMAND_TIMEOUT" } },
      });
      expect(findSessionOwnerNodeId).not.toHaveBeenCalled();
      expect(findRescuableSessionOwnerNodeId).toHaveBeenCalledWith("generated-session");
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(harness.registry.getConnectedNode("node-codex")).toMatchObject({
        pendingCommandCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createHarness(options: {
  timeoutMs?: number;
  createSessionReconcileTimeoutMs?: number;
  findSessionOwnerNodeId?: (agentSessionId: string) => Promise<string | null>;
  findRescuableSessionOwnerNodeId?: (agentSessionId: string) => Promise<string | null>;
  modelPresetAvailability?: Pick<ModelPresetAvailabilityService, "requireAvailable">;
} = {}) {
  const registry = new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType, nowMs }) =>
      `cmd-${commandType}-${sequence}-${nowMs}`,
  });
  const transports = new NodeCommandTransportHub();
  const router = new SessionCommandRouter({
    registry,
    findSessionOwnerNodeId: options.findSessionOwnerNodeId,
    findRescuableSessionOwnerNodeId: options.findRescuableSessionOwnerNodeId,
  });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  const sessionEventHub = new RuntimeSessionEventHub();
  const provider = createLiveExecuteProxyRouteProvider({
    registry,
    router,
    bridge,
    sessionEventHub,
    timeoutMs: options.timeoutMs,
    createSessionReconcileTimeoutMs: options.createSessionReconcileTimeoutMs,
    generateSessionId: () => "generated-session",
    modelPresetAvailability: options.modelPresetAvailability,
  });

  return {
    registry,
    provider,
    sessionEventHub,
    registerNode: (input: {
      nodeId: string;
      agents: unknown[];
      supportedBackends: string[];
      modelPresets?: unknown[];
    }) => {
      const connectionId = registry.registerNode({
        type: "node_register",
        node_id: input.nodeId,
        host: "127.0.0.1",
        port: 4105,
        agents: input.agents,
        capabilities: { max_concurrent: 8, runner_inventory_v1: true },
        supported_backends: input.supportedBackends,
        model_presets: input.modelPresets,
      }).node.connectionId;
      registry.receiveNodeMessage(input.nodeId, {
        type: "runner_inventory",
        running_session_ids: [],
      });
      return connectionId;
    },
    attachTransport: (
      nodeId: string,
      connectionId: string,
      onMessage?: (message: Record<string, unknown>) => void,
    ) => {
      const sent: Record<string, unknown>[] = [];
      transports.attach({
        nodeId,
        connectionId,
        transport: {
          send: (data) => {
            const message = JSON.parse(data) as Record<string, unknown>;
            sent.push(message);
            onMessage?.(message);
          },
        },
      });
      return sent;
    },
    receive: (
      nodeId: string,
      connectionId: string,
      message: Record<string, unknown>,
    ) => {
      sessionEventHub.dispatchNodeRegistryEvents(
        registry.receiveNodeMessage({ nodeId, connectionId }, message),
      );
    },
  };
}

function observeUnsubscribe(sessionEventHub: RuntimeSessionEventHub) {
  const unsubscribeObserved = vi.fn();
  const subscribe = sessionEventHub.subscribe.bind(sessionEventHub);
  vi.spyOn(sessionEventHub, "subscribe").mockImplementation((sessionId, listener) => {
    const unsubscribe = subscribe(sessionId, listener);
    return () => {
      unsubscribeObserved();
      unsubscribe();
    };
  });
  return unsubscribeObserved;
}

async function resultBody(result: ExecuteProxyResult): Promise<string> {
  if (!("body" in result)) throw new Error("expected text execute result");
  if (typeof result.body === "string") return result.body;
  const chunks: Buffer[] = [];
  for await (const chunk of result.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
