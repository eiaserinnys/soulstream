import type {
  AgentProfileUpdateInput,
  ApplyAgentProfileUpdateInput,
  NodeAgentProfileProvider,
  NodeAgentProfileRouteOptions,
  NodePortraitResult,
  RawNodeAgentProfile,
  RollbackAgentsConfigInput,
} from "../node/node_agent_profile_routes.js";
import { NodeAgentProfileRouteError } from "../node/node_agent_profile_routes.js";
import type {
  NodeCommandResponse,
  PendingNodeCommand,
  RequestResponseNodeCommandPayload,
} from "../node/pending_commands.js";
import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
} from "../node/pending_commands.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import { NodeCommandTransportError } from "../session/session_command_transport.js";
import type { RoutedPendingSessionCommand } from "../session/session_command_router.js";
import type {
  LiveNodeHttpClientBoundary,
  LiveNodeHttpResponse,
} from "./live_provider_dependencies.js";
import { LiveNodeHttpClientError } from "./live_node_http_client.js";

type AgentSnapshot = {
  readonly id: string;
  readonly name?: unknown;
  readonly portrait_url?: unknown;
  readonly max_turns?: unknown;
  readonly backend?: unknown;
  readonly portrait_b64?: unknown;
};

type LiveNodeAgentProfileRegistry = {
  readonly getConnectedNode: (nodeId: string) => NodeConnectionSnapshot | undefined;
  readonly createCommand: <
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    nodeId: string,
    payload: TPayload,
    options?: { timeoutMs?: number },
  ) => PendingNodeCommand<TPayload, TResponse>;
};

type LiveNodeAgentProfileBridge = {
  readonly sendPendingCommand: <
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse,
  >(
    routed: RoutedPendingSessionCommand<TPayload, TResponse>,
  ) => Promise<TResponse>;
};

type LiveNodeAgentProfileHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type CreateLiveNodeAgentProfileRouteProviderOptions = {
  readonly registry: LiveNodeAgentProfileRegistry;
  readonly bridge: LiveNodeAgentProfileBridge;
  readonly nodeHttpClient: LiveNodeAgentProfileHttpClient;
};

export type LiveNodeAgentProfileRouteProviderBundle = {
  readonly nodeAgentProfileRoutes: Pick<NodeAgentProfileRouteOptions, "provider">;
};

export function createLiveNodeAgentProfileRouteProviders(
  options: CreateLiveNodeAgentProfileRouteProviderOptions,
): LiveNodeAgentProfileRouteProviderBundle {
  return {
    nodeAgentProfileRoutes: {
      provider: createLiveNodeAgentProfileProvider(options),
    },
  };
}

function createLiveNodeAgentProfileProvider(
  options: CreateLiveNodeAgentProfileRouteProviderOptions,
): NodeAgentProfileProvider {
  return {
    listAgentProfiles: async (nodeId) => {
      const node = options.registry.getConnectedNode(nodeId);
      if (node === undefined) return undefined;
      return Object.fromEntries(
        agentSnapshots(node).map((agent) => [
          agent.id,
          {
            name: agent.name,
            portrait_url: agent.portrait_url,
            max_turns: agent.max_turns,
            backend: agent.backend,
          } satisfies RawNodeAgentProfile,
        ]),
      );
    },
    getAgentPortrait: async (nodeId, agentId) => {
      const node = options.registry.getConnectedNode(nodeId);
      if (node === undefined) return { status: "missing" };
      const cached = agentSnapshots(node).find((agent) => agent.id === agentId)
        ?.portrait_b64;
      if (typeof cached === "string" && cached.length > 0) {
        return { status: "cached", body: cached, encoding: "base64" };
      }
      return requestPortrait(
        options,
        nodeId,
        `/api/agents/${encodeURIComponent(agentId)}/portrait`,
      );
    },
    getUserPortrait: async (nodeId) =>
      requestPortrait(options, nodeId, "/api/dashboard/portrait/user"),
    planAgentProfileUpdate: async (nodeId, input) =>
      sendConfigCommand(options, nodeId, planPayload(input)),
    applyAgentProfileUpdate: async (nodeId, input) =>
      sendConfigCommand(options, nodeId, applyPayload(input)),
    listAgentsConfigSnapshots: async (nodeId) =>
      sendConfigCommand(options, nodeId, {
        type: "list_agents_config_snapshots",
      }),
    rollbackAgentsConfig: async (nodeId, input) =>
      sendConfigCommand(options, nodeId, rollbackPayload(input)),
  };
}

function agentSnapshots(node: NodeConnectionSnapshot): AgentSnapshot[] {
  return node.agents.filter(isAgentSnapshot);
}

function isAgentSnapshot(value: unknown): value is AgentSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

async function requestPortrait(
  options: CreateLiveNodeAgentProfileRouteProviderOptions,
  nodeId: string,
  path: string,
): Promise<NodePortraitResult> {
  try {
    return upstreamPortrait(
      await options.nodeHttpClient.requestNode({
        nodeId,
        method: "GET",
        path,
        responseType: "arrayBuffer",
      }),
    );
  } catch (error) {
    if (error instanceof LiveNodeHttpClientError) {
      return { status: "requestFailure" };
    }
    throw error;
  }
}

function upstreamPortrait(response: LiveNodeHttpResponse): NodePortraitResult {
  return {
    status: "upstream",
    statusCode: response.statusCode,
    body: portraitBody(response.body),
    contentType: headerValue(response.headers, "content-type"),
  };
}

function portraitBody(body: unknown): Buffer | Uint8Array | string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(String(body));
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

type AgentProfileUpdateCommandPayload =
  RequestResponseNodeCommandPayload<"plan_agent_profile_update"> & {
    profile: Record<string, unknown>;
    create_if_missing: boolean;
    include_text_diff: boolean;
  };

type ApplyAgentProfileUpdateCommandPayload =
  RequestResponseNodeCommandPayload<"apply_agent_profile_update"> & {
    profile: Record<string, unknown>;
    create_if_missing: boolean;
    include_text_diff: boolean;
    expected_config_checksum?: string | null;
  };

type ListAgentsConfigSnapshotsCommandPayload =
  RequestResponseNodeCommandPayload<"list_agents_config_snapshots">;

type RollbackAgentsConfigCommandPayload =
  RequestResponseNodeCommandPayload<"rollback_agents_config"> & {
    include_text_diff: boolean;
    snapshot_path?: string | null;
    snapshot_id?: string | null;
  };

type AgentConfigCommandPayload =
  | AgentProfileUpdateCommandPayload
  | ApplyAgentProfileUpdateCommandPayload
  | ListAgentsConfigSnapshotsCommandPayload
  | RollbackAgentsConfigCommandPayload;

function planPayload(
  input: AgentProfileUpdateInput,
): AgentProfileUpdateCommandPayload {
  return {
    type: "plan_agent_profile_update",
    profile: input.profile,
    create_if_missing: input.createIfMissing,
    include_text_diff: input.includeTextDiff,
  };
}

function applyPayload(
  input: ApplyAgentProfileUpdateInput,
): ApplyAgentProfileUpdateCommandPayload {
  return omitUndefined({
    type: "apply_agent_profile_update",
    profile: input.profile,
    create_if_missing: input.createIfMissing,
    include_text_diff: input.includeTextDiff,
    expected_config_checksum: input.expectedConfigChecksum,
  });
}

function rollbackPayload(
  input: RollbackAgentsConfigInput,
): RollbackAgentsConfigCommandPayload {
  return omitUndefined({
    type: "rollback_agents_config",
    include_text_diff: input.includeTextDiff,
    snapshot_path: input.snapshotPath,
    snapshot_id: input.snapshotId,
  });
}

function omitUndefined<TValue extends Record<string, unknown>>(value: TValue): TValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as TValue;
}

async function sendConfigCommand<TPayload extends AgentConfigCommandPayload>(
  options: CreateLiveNodeAgentProfileRouteProviderOptions,
  nodeId: string,
  payload: TPayload,
): Promise<NodeCommandResponse> {
  const node = requireConnectedNode(options.registry, nodeId);
  try {
    const command = options.registry.createCommand<TPayload, NodeCommandResponse>(
      nodeId,
      payload,
    );
    return await options.bridge.sendPendingCommand({ node, command });
  } catch (error) {
    throw mapCommandError(error);
  }
}

function requireConnectedNode(
  registry: LiveNodeAgentProfileRegistry,
  nodeId: string,
): NodeConnectionSnapshot {
  const node = registry.getConnectedNode(nodeId);
  if (node !== undefined) return node;
  throw new NodeAgentProfileRouteError(
    "NODE_NOT_CONNECTED",
    `Node ${nodeId} not connected`,
    404,
  );
}

function mapCommandError(error: unknown): NodeAgentProfileRouteError {
  if (error instanceof NodeAgentProfileRouteError) return error;
  if (
    error instanceof NodeCommandTransportError ||
    error instanceof PendingNodeCommandTimeoutError ||
    isDisconnectedCommandError(error)
  ) {
    return new NodeAgentProfileRouteError(
      "NODE_AGENT_PROFILE_COMMAND_UNAVAILABLE",
      error.message,
      503,
    );
  }
  if (error instanceof PendingNodeCommandRejectedError) {
    return new NodeAgentProfileRouteError(
      "NODE_AGENT_PROFILE_COMMAND_REJECTED",
      error.message,
      400,
    );
  }
  return new NodeAgentProfileRouteError(
    "NODE_AGENT_PROFILE_COMMAND_FAILED",
    error instanceof Error ? error.message : String(error),
    400,
  );
}

function isDisconnectedCommandError(error: unknown): error is Error {
  return (
    error instanceof Error && error.message.toLowerCase().includes("not connected")
  );
}
