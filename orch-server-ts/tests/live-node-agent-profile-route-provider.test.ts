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
import { signJwt, verifySignedJwt } from "../src/runtime/live_auth_route_provider.js";

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
          aliases: [{ id: "agent-a-opus", default_preset: "claude-opus" }],
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
        source: "yaml",
      },
      "agent-b": {
        name: "Agent B",
        portrait_url: undefined,
        max_turns: undefined,
        backend: undefined,
        source: "yaml",
      },
    });
    await expect(provider.listAgentProfiles("missing-node")).resolves.toBeUndefined();
  });

  it("marks agents backed by a central profile row as source db and overlays its identity fields", async () => {
    const { provider } = createFixture({
      agents: [{ id: "agent-a", name: "YAML Name", default_preset: "yaml-preset" }],
      agentProfileRepository: {
        list: async () => [{
          agentId: "agent-a",
          name: "DB Name",
          contextBundles: [],
          atomContexts: [],
          defaultPreset: "db-preset",
          aliases: ["agent-a-alias"],
          hasPortrait: false,
          portrait: null,
          version: 2,
          createdAt: "2026-11-15T00:00:00.000Z",
          updatedAt: "2026-11-15T00:00:00.000Z",
        }],
      },
    });

    await expect(provider.listAgentProfiles("node-a")).resolves.toEqual({
      "agent-a": {
        name: "DB Name",
        portrait_url: undefined,
        max_turns: undefined,
        backend: undefined,
        default_preset: "db-preset",
        aliases: ["agent-a-alias"],
        source: "db",
      },
    });
  });

  it("requests user portraits with forwarded auth headers as binary live node HTTP responses", async () => {
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
      provider.getUserPortrait("node-a", {
        headers: { cookie: "session=abc" },
      }),
    ).resolves.toEqual({
      status: "upstream",
      statusCode: 200,
      body: portraitBytes,
      contentType: "image/png",
    });
    expect(requestNode).toHaveBeenLastCalledWith({
      nodeId: "node-a",
      method: "GET",
      path: "/api/dashboard/portrait/user",
      headers: { cookie: "session=abc" },
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

    await expect(provider.getUserPortrait("node-a")).resolves.toEqual({
      status: "requestFailure",
    });
    expect(requestNode).toHaveBeenCalledTimes(1);
  });

  it("proxies context previews over live node HTTP with caller auth", async () => {
    const preview = {
      manifest: {
        sources: [{ id: "profile:0", status: "filtered", chars: 0, token_estimate: 0 }],
      },
    };
    const { provider, requestNode } = createFixture({
      requestNode: vi.fn(async () => ({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: preview,
      })),
    });
    const input = {
      atom_contexts: [{ node_id: "9e91bf3d-b682-4c12-b42e-93fcb51344a5" }],
      session: { source: "browser" },
    };

    await expect(provider.previewAgentContext("node-a", input, {
      headers: {
        authorization: "Bearer caller-token",
        cookie: "session=abc",
        "x-forwarded-for": "203.0.113.10",
      },
    })).resolves.toEqual(preview);
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "node-a",
      method: "POST",
      path: "/api/context/preview",
      headers: {
        authorization: "Bearer caller-token",
        cookie: "session=abc",
      },
      body: input,
    });
  });

  it("mints the node dashboard cookie for previews and portraits when a Tailscale user has no cookie or authorization", async () => {
    const { provider, requestNode } = createFixture({
      requestNode: vi.fn(async () => ({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: {},
      })),
      forwardAuth: {
        resolveUser: async (headers) => headers["tailscale-user-login"] === "owner@example.com"
          ? { payload: { email: "owner@example.com", name: "owner@example.com" }, carrier: "tailscale" }
          : null,
        readJwtSecret: async () => "provider-test-secret",
        signJwt,
      },
    });
    const requestOptions = { headers: { "tailscale-user-login": "owner@example.com" } };

    await provider.previewAgentContext("node-a", { agent_id: "agent-a" }, requestOptions);
    await provider.getUserPortrait("node-a", requestOptions);

    expect(requestNode).toHaveBeenCalledTimes(2);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const requests = vi.mocked(requestNode).mock.calls.map(
      (call) => (call as unknown as Parameters<ProviderOptions["nodeHttpClient"]["requestNode"]>)[0],
    );
    for (const request of requests) {
      expect(Object.keys(request.headers ?? {})).toEqual(["cookie"]);
      const token = request.headers?.cookie?.match(/^soul_dashboard_auth=(.+)$/)?.[1];
      expect(verifySignedJwt(token ?? "", "provider-test-secret", nowSeconds)).toMatchObject({
        email: "owner@example.com",
      });
    }
    expect(requests.map((request) => request.path)).toEqual([
      "/api/context/preview",
      "/api/dashboard/portrait/user",
    ]);
  });

  it("forwards agent preview requests and preserves a node 404", async () => {
    const { provider, requestNode } = createFixture({
      requestNode: vi.fn(async () => ({
        statusCode: 404, headers: { "content-type": "application/json" },
        body: { detail: "Unknown agent" },
      })),
    });
    const input = { agent_id: "missing", session: { backend: "codex" } };
    await expect(provider.previewAgentContext("node-a", input)).rejects.toMatchObject({
      statusCode: 404, message: "Unknown agent",
    });
    expect(requestNode).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "node-a", path: "/api/context/preview", body: input,
    }));
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
  agentProfileRepository?: ProviderOptions["agentProfileRepository"];
  forwardAuth?: ProviderOptions["forwardAuth"];
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
        result: { ok: true },
      } as unknown as TResponse;
    },
  };

  const bundle = createLiveNodeAgentProfileRouteProviders({
    registry,
    bridge,
    nodeHttpClient: { requestNode },
    agentProfileRepository: input.agentProfileRepository ?? {
      list: async () => [],
    },
    ...(input.forwardAuth ? { forwardAuth: input.forwardAuth } : {}),
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
