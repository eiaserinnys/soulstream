import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  LiveNodeHttpClientError,
  NodeAgentProfileRouteError,
  NodeCommandTransportError,
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  createLiveNodeAgentProfileRouteProviders,
  type NodeCommandResponse,
  type RequestResponseNodeCommandPayload,
  type RoutedPendingSessionCommand,
} from "../src/index.js";

type ProviderOptions = Parameters<typeof createLiveNodeAgentProfileRouteProviders>[0];

describe("live node agent profile route provider", () => {
  it("projects connected registry agent snapshots and filters invalid ids", async () => {
    const { provider } = createFixture({
      agents: [
        {
          id: "agent-a",
          name: "Agent A",
          portrait_url: "/api/agents/agent-a/portrait",
          max_turns: 8,
          backend: "codex",
        },
        { id: 123, name: "Invalid" },
        { id: "agent-b", name: "Agent B" },
      ],
    });

    await expect(provider.listAgentProfiles("node-a")).resolves.toEqual({
      "agent-a": {
        name: "Agent A",
        portrait_url: "/api/agents/agent-a/portrait",
        max_turns: 8,
        backend: "codex",
      },
      "agent-b": {
        name: "Agent B",
        portrait_url: undefined,
        max_turns: undefined,
        backend: undefined,
      },
    });
    await expect(provider.listAgentProfiles("missing-node")).resolves.toBeUndefined();
  });

  it("returns cached registration portraits before hitting node HTTP", async () => {
    const portrait = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const { provider, requestNode } = createFixture({
      agents: [{ id: "agent-a", portrait_b64: portrait }],
    });

    await expect(provider.getAgentPortrait("node-a", "agent-a")).resolves.toEqual({
      status: "cached",
      body: portrait,
      encoding: "base64",
    });
    expect(requestNode).not.toHaveBeenCalled();
  });

  it("requests agent and user portraits as binary live node HTTP responses", async () => {
    const portraitBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    const { provider, requestNode } = createFixture({
      agents: [{ id: "remote agent" }],
      requestNode: vi.fn(async () => ({
        statusCode: 200,
        headers: { "content-type": "image/png" },
        body: portraitBytes,
      })),
    });

    await expect(
      provider.getAgentPortrait("node-a", "remote agent"),
    ).resolves.toEqual({
      status: "upstream",
      statusCode: 200,
      body: portraitBytes,
      contentType: "image/png",
    });
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "node-a",
      method: "GET",
      path: "/api/agents/remote%20agent/portrait",
      responseType: "arrayBuffer",
    });

    await expect(provider.getUserPortrait("node-a")).resolves.toEqual({
      status: "upstream",
      statusCode: 200,
      body: portraitBytes,
      contentType: "image/png",
    });
    expect(requestNode).toHaveBeenLastCalledWith({
      nodeId: "node-a",
      method: "GET",
      path: "/api/dashboard/portrait/user",
      responseType: "arrayBuffer",
    });
  });

  it("returns portrait miss/failure statuses without creating a user cache", async () => {
    const { provider, requestNode } = createFixture({
      requestNode: vi.fn(async () => {
        throw new LiveNodeHttpClientError(
          "NODE_HTTP_REQUEST_FAILED",
          "network failed",
          { nodeId: "node-a" },
        );
      }),
    });

    await expect(provider.getAgentPortrait("missing-node", "agent-a")).resolves.toEqual({
      status: "missing",
    });
    await expect(provider.getUserPortrait("node-a")).resolves.toEqual({
      status: "requestFailure",
    });
    expect(requestNode).toHaveBeenCalledTimes(1);
  });

  it("sends config commands through registry createCommand and websocket bridge", async () => {
    const { provider, sentMessages } = createFixture();

    await provider.planAgentProfileUpdate("node-a", {
      profile: { id: "agent-a" },
      createIfMissing: true,
      includeTextDiff: true,
    });
    await provider.applyAgentProfileUpdate("node-a", {
      profile: { id: "agent-a" },
      createIfMissing: false,
      includeTextDiff: true,
      expectedConfigChecksum: "checksum-a",
    });
    await provider.listAgentsConfigSnapshots("node-a");
    await provider.rollbackAgentsConfig("node-a", {
      snapshotId: "snapshot-a",
      includeTextDiff: false,
    });

    expect(sentMessages).toEqual([
      {
        type: "plan_agent_profile_update",
        profile: { id: "agent-a" },
        create_if_missing: true,
        include_text_diff: true,
        requestId: "req-1-plan_agent_profile_update",
      },
      {
        type: "apply_agent_profile_update",
        profile: { id: "agent-a" },
        create_if_missing: false,
        include_text_diff: true,
        expected_config_checksum: "checksum-a",
        requestId: "req-2-apply_agent_profile_update",
      },
      {
        type: "list_agents_config_snapshots",
        requestId: "req-3-list_agents_config_snapshots",
      },
      {
        type: "rollback_agents_config",
        include_text_diff: false,
        snapshot_id: "snapshot-a",
        requestId: "req-4-rollback_agents_config",
      },
    ]);
  });

  it("maps missing nodes and command failures to route status semantics", async () => {
    const missingNode = createFixture();
    await expect(
      missingNode.provider.planAgentProfileUpdate("missing-node", {
        profile: {},
        createIfMissing: false,
        includeTextDiff: false,
      }),
    ).rejects.toMatchObject({ code: "NODE_NOT_CONNECTED", statusCode: 404 });

    await expect(configCommandFailure(transportError())).rejects.toMatchObject({
      code: "NODE_AGENT_PROFILE_COMMAND_UNAVAILABLE",
      statusCode: 503,
    });
    await expect(configCommandFailure(timeoutError())).rejects.toMatchObject({
      code: "NODE_AGENT_PROFILE_COMMAND_UNAVAILABLE",
      statusCode: 503,
    });
    await expect(configCommandFailure(new Error("node is not connected: node-a")))
      .rejects.toMatchObject({
        code: "NODE_AGENT_PROFILE_COMMAND_UNAVAILABLE",
        statusCode: 503,
      });
    await expect(configCommandFailure(rejectedError())).rejects.toMatchObject({
      code: "NODE_AGENT_PROFILE_COMMAND_REJECTED",
      statusCode: 400,
    });
    await expect(
      configCommandFailure(new Error("node runtime failed")),
    ).rejects.toBeInstanceOf(NodeAgentProfileRouteError);
  });
});

function createFixture(input: {
  agents?: unknown[];
  requestNode?: ProviderOptions["nodeHttpClient"]["requestNode"];
  bridgeError?: unknown;
} = {}) {
  const registry = new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType }) =>
      `req-${sequence}-${commandType}`,
  });
  registry.registerNode({
    type: "node_register",
    node_id: "node-a",
    host: "127.0.0.1",
    port: 4105,
    agents: input.agents ?? [{ id: "agent-a" }],
  });

  const sentMessages: Record<string, unknown>[] = [];
  const requestNode =
    input.requestNode ??
    vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "image/png" },
      body: Buffer.from("portrait"),
    }));
  const bridge: ProviderOptions["bridge"] = {
    sendPendingCommand: async <
      TPayload extends RequestResponseNodeCommandPayload,
      TResponse extends NodeCommandResponse,
    >(
      routed: RoutedPendingSessionCommand<TPayload, TResponse>,
    ): Promise<TResponse> => {
      sentMessages.push(routed.command.message);
      if (input.bridgeError !== undefined) throw input.bridgeError;
      return {
        type: `${routed.command.commandType}_result`,
        requestId: routed.command.requestId,
      } as TResponse;
    },
  };

  const bundle = createLiveNodeAgentProfileRouteProviders({
    registry,
    bridge,
    nodeHttpClient: { requestNode },
  });
  return {
    provider: bundle.nodeAgentProfileRoutes.provider,
    requestNode,
    sentMessages,
  };
}

async function configCommandFailure(error: unknown): Promise<unknown> {
  const { provider } = createFixture({ bridgeError: error });
  return provider.planAgentProfileUpdate("node-a", {
    profile: {},
    createIfMissing: false,
    includeTextDiff: false,
  });
}

function transportError(): NodeCommandTransportError {
  return new NodeCommandTransportError({
    code: "TRANSPORT_SEND_FAILED",
    nodeId: "node-a",
    connectionId: "node-a-conn-1",
    message: "send failed",
  });
}

function timeoutError(): PendingNodeCommandTimeoutError {
  return new PendingNodeCommandTimeoutError({
    commandType: "plan_agent_profile_update",
    requestId: "req-1-plan_agent_profile_update",
    timeoutMs: 30_000,
  });
}

function rejectedError(): PendingNodeCommandRejectedError {
  return new PendingNodeCommandRejectedError({
    commandType: "plan_agent_profile_update",
    requestId: "req-1-plan_agent_profile_update",
    message: "node rejected command",
  });
}
