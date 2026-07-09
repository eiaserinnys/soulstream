import { describe, expect, it } from "vitest";

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
    harness.registry.sessionCache.upsertFromCommandAck({
      nodeId: "node-a",
      connectionId,
      response: { type: "session_created", agentSessionId: "sess-existing" },
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
    });
    await expect(resultBody(result)).resolves.toBe(
      'event: init\n' +
        'data: {"type":"init","agent_session_id":"sess-existing","node_id":"node-a"}\n\n' +
        'event: complete\n' +
        'id: 11\n' +
        'data: {"type":"complete","result":"resumed"}\n\n',
    );
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
});

function createHarness() {
  const registry = new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType, nowMs }) =>
      `cmd-${commandType}-${sequence}-${nowMs}`,
  });
  const transports = new NodeCommandTransportHub();
  const router = new SessionCommandRouter({ registry });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  const sessionEventHub = new RuntimeSessionEventHub();
  const provider = createLiveExecuteProxyRouteProvider({
    registry,
    router,
    bridge,
    sessionEventHub,
    generateSessionId: () => "generated-session",
  });

  return {
    registry,
    provider,
    registerNode: (input: {
      nodeId: string;
      agents: unknown[];
      supportedBackends: string[];
    }) =>
      registry.registerNode({
        type: "node_register",
        node_id: input.nodeId,
        host: "127.0.0.1",
        port: 4105,
        agents: input.agents,
        supported_backends: input.supportedBackends,
      }).node.connectionId,
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

async function resultBody(result: ExecuteProxyResult): Promise<string> {
  if (!("body" in result)) throw new Error("expected text execute result");
  if (typeof result.body === "string") return result.body;
  const chunks: Buffer[] = [];
  for await (const chunk of result.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
