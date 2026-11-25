import { isRecord } from "@soulstream/wire-schema/json-record";
import {
  NodeAgentProfileRouteError,
  type AgentProfileUpdateInput,
  type AgentContextPreviewInput,
  type ApplyAgentProfileUpdateInput,
  type NodeAgentProfileProvider,
  type NodeAgentProfileRouteOptions,
  type NodePortraitRequestOptions,
  type NodePortraitResult,
  type RawNodeAgentProfile,
  type RollbackAgentsConfigInput,
} from "../node/node_agent_profile_routes.js";
import type {
  NodeCommandResponse,
  RequestResponseNodeCommandPayload,
} from "../node/pending_commands.js";
import type {
  NodeCommandRegistryPort,
  NodeConnectionSnapshot,
} from "../node/registry_types.js";
import { mapNodeCommandError } from "../http/api_errors.js";
import type { RoutedPendingSessionCommand } from "../session/session_command_router.js";
import type {
  LiveNodeHttpClientBoundary,
  LiveNodeHttpResponse,
} from "./live_provider_dependencies.js";
import { LiveNodeHttpClientError } from "./live_node_http_client.js";
import type { AgentProfileRepository } from "../node/agent_profile_routes.js";
import {
  buildNodeForwardAuthHeaders,
  headerValue,
  type NodeForwardAuthIssuer,
} from "../node/node_forward_auth_headers.js";

type AgentSnapshot = {
  readonly id: string;
  readonly name?: unknown;
  readonly portrait_url?: unknown;
  readonly max_turns?: unknown;
  readonly backend?: unknown;
  readonly default_preset?: unknown;
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
  readonly registry: NodeCommandRegistryPort;
  readonly bridge: LiveNodeAgentProfileBridge;
  readonly nodeHttpClient: LiveNodeAgentProfileHttpClient;
  readonly agentProfileRepository: Pick<AgentProfileRepository, "list">;
  /** Mints the node cookie for Tailscale callers; absent means cookie/authorization only. */
  readonly forwardAuth?: NodeForwardAuthIssuer;
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
      const dbProfiles = new Map(
        (await options.agentProfileRepository.list()).map((profile) => [profile.agentId, profile]),
      );
      return Object.fromEntries(
        agentSnapshots(node).map((agent) => {
          const dbProfile = dbProfiles.get(agent.id);
          return [agent.id, {
            name: dbProfile?.name ?? agent.name,
            portrait_url: agent.portrait_url,
            max_turns: agent.max_turns,
            backend: agent.backend,
            default_preset: dbProfile
              ? dbProfile.defaultPreset ?? undefined
              : agent.default_preset,
            aliases: dbProfile?.aliases,
            source: dbProfile ? "db" : "yaml",
          } satisfies RawNodeAgentProfile];
        }),
      );
    },
    getUserPortrait: async (nodeId, requestOptions) =>
      requestPortrait(
        options,
        nodeId,
        "/api/dashboard/portrait/user",
        requestOptions,
      ),
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
    previewAgentContext: async (nodeId, input, requestOptions) =>
      previewAgentContext(options, nodeId, input, requestOptions),
  };
}

async function previewAgentContext(
  options: CreateLiveNodeAgentProfileRouteProviderOptions,
  nodeId: string,
  input: AgentContextPreviewInput,
  requestOptions?: NodePortraitRequestOptions,
): Promise<unknown> {
  const headers = await buildNodeForwardAuthHeaders(
    requestOptions?.headers,
    options.forwardAuth,
  );
  let response: LiveNodeHttpResponse;
  try {
    response = await options.nodeHttpClient.requestNode({
      nodeId,
      method: "POST",
      path: "/api/context/preview",
      ...(headers ? { headers } : {}),
      body: input,
    });
  } catch (error) {
    if (error instanceof LiveNodeHttpClientError) {
      throw new NodeAgentProfileRouteError(
        "NODE_AGENT_CONTEXT_PREVIEW_UNAVAILABLE",
        error.message,
        503,
      );
    }
    throw error;
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new NodeAgentProfileRouteError(
      "NODE_AGENT_CONTEXT_PREVIEW_FAILED",
      responseDetail(response.body) ?? `Context preview returned HTTP ${response.statusCode}`,
      response.statusCode,
    );
  }
  return response.body;
}

function responseDetail(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return typeof body === "string" && body.length > 0 ? body : undefined;
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
  requestOptions?: NodePortraitRequestOptions,
): Promise<NodePortraitResult> {
  try {
    const headers = await buildNodeForwardAuthHeaders(
      requestOptions?.headers,
      options.forwardAuth,
    );
    return upstreamPortrait(
      await options.nodeHttpClient.requestNode({
        nodeId,
        method: "GET",
        path,
        ...(headers ? { headers } : {}),
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
  registry: NodeCommandRegistryPort,
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
  const nodeCommandError = mapNodeCommandError(error);
  if (nodeCommandError?.kind === "transport"
    || nodeCommandError?.kind === "timeout"
    || isDisconnectedCommandError(error)) {
    const message = nodeCommandError?.apiError.message;
    return new NodeAgentProfileRouteError(
      "NODE_AGENT_PROFILE_COMMAND_UNAVAILABLE",
      typeof message === "string" ? message : error instanceof Error ? error.message : String(error),
      503,
    );
  }
  if (nodeCommandError?.kind === "rejected") {
    const responseCode = nodeCommandError.response?.code;
    return new NodeAgentProfileRouteError(
      typeof responseCode === "string"
        ? responseCode
        : "NODE_AGENT_PROFILE_COMMAND_REJECTED",
      nodeCommandError.apiError.message,
      400,
      isRecord(nodeCommandError.response?.details) ? nodeCommandError.response.details : undefined,
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
