import { randomUUID } from "node:crypto";

import {
  Agent,
  codeInterpreterTool,
  fileSearchTool,
  hostedMcpTool,
  imageGenerationTool,
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  OpenAIProvider,
  Runner,
  tool,
  toolSearchTool,
  RunState,
  type RunToolApprovalItem,
  type Session,
  type StreamedRunResult,
  type Tool,
  webSearchTool,
  type AgentInputItem,
  type MCPServer,
} from "@openai/agents";
import type { Logger } from "pino";

import type { AgentProfile, AgentsSdkConfig } from "../agent_registry.js";

import { mapAgentsGuardrailError, mapAgentsRunStreamEvent } from "./agents_event_mapper.js";
import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  SessionItemsSnapshotCallback,
  SSEEventPayload,
  SupportsToolApproval,
  QueuedToolApprovalDecision,
  ToolApprovalDecision,
  ToolApprovalDeliveryOptions,
  ToolApprovalDeliveryResult,
} from "./protocol.js";

interface PendingApproval {
  item: RunToolApprovalItem;
  promise: Promise<PendingApprovalDecision>;
  resolve: (decision: PendingApprovalDecision) => void;
  resolved: boolean;
}

interface PendingApprovalDecision {
  decision: ToolApprovalDecision;
  options: ToolApprovalDeliveryOptions;
}

type AnyAgent = Agent<any, any>;
const AGENTS_RUN_STATE_SCHEMA_VERSION = "1.11";

export interface AgentsAdapterConfig {
  workspaceDir: string;
  profile: AgentProfile;
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * OpenAI Agents SDK EnginePort 구현.
 *
 * Runner/Agent/Handoff/Guardrail/Approval 흐름을 TS 서버의 기존 task lifecycle에
 * 맞춘다. SDK RunState는 in-memory approval resume에만 보관하고 DB에는 Soulstream
 * SSE events가 정본으로 남는다.
 */
export class AgentsEngineAdapter implements EnginePort, SupportsToolApproval {
  public readonly backendId: BackendId = "openai-agents";
  public readonly workspaceDir: string;

  private readonly runner: Runner;
  private readonly entryAgent: AnyAgent;
  private readonly maxTurns?: number;
  private readonly logger: Logger;
  private readonly mcpServers: MCPServer[];
  private readonly openAIProvider?: OpenAIProvider;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private currentTurn: AbortController | null = null;
  private mcpConnected = false;
  private closed = false;
  private resourcesClosed = false;
  private running = false;

  constructor(config: AgentsAdapterConfig, logger: Logger) {
    this.workspaceDir = config.workspaceDir;
    this.logger = logger;
    if (!config.profile.agents_sdk) {
      throw new Error(
        `AgentsEngineAdapter requires agents_sdk config (agent=${config.profile.id})`,
      );
    }
    const graph = buildAgentGraph(config.profile.agents_sdk);
    this.mcpServers = graph.mcpServers;
    const entry = graph.agents.get(config.profile.agents_sdk.entry_agent);
    if (!entry) {
      throw new Error(
        `agents_sdk.entry_agent not found: ${config.profile.agents_sdk.entry_agent}`,
      );
    }
    this.entryAgent = entry;
    this.maxTurns = config.profile.agents_sdk.max_turns ?? config.profile.max_turns;
    this.openAIProvider = buildOpenAIProvider(
      config.profile.agents_sdk,
      config.processEnv ?? process.env,
    );
    this.runner = new Runner({
      ...(this.openAIProvider ? { modelProvider: this.openAIProvider } : {}),
      tracingDisabled: true,
      inputGuardrails: buildInputGuardrails(config.profile.agents_sdk),
      outputGuardrails: buildOutputGuardrails(config.profile.agents_sdk),
    });
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    if (this.closed) {
      throw new Error("AgentsEngineAdapter.execute called after close()");
    }
    if (this.running) {
      throw new Error("AgentsEngineAdapter.execute: concurrent run not supported");
    }
    this.running = true;

    const sessionId = params.resumeSessionId ?? `agents-${randomUUID()}`;
    if (!params.resumeSessionId) {
      await params.onSession?.(sessionId);
      yield {
        type: "session",
        session_id: sessionId,
      } as SSEEventPayload;
    }

    await this.connectMcpServersOnce();
    const sdkSession = new SoulstreamAgentsSession(
      sessionId,
      params.sessionItems,
      params.onSessionItemsSnapshot,
    );
    let nextInput: string | RunState<any, AnyAgent> = params.resumeRunState
      ? await RunState.fromString(this.entryAgent, params.resumeRunState)
      : params.prompt;
    if (nextInput instanceof RunState && params.queuedToolApproval) {
      applyQueuedToolApproval(nextInput, params.queuedToolApproval);
    }
    try {
      while (!this.closed) {
        const controller = new AbortController();
        this.currentTurn = controller;
        let result: StreamedRunResult<any, AnyAgent>;
        try {
          result = await this.runner.run(this.entryAgent, nextInput, {
            stream: true,
            maxTurns: this.maxTurns,
            signal: controller.signal,
            session: sdkSession,
            ...(params.previousResponseId ? { previousResponseId: params.previousResponseId } : {}),
            ...(params.conversationId ? { conversationId: params.conversationId } : {}),
          });
        } catch (err) {
          const guardrailEvents = mapAgentsGuardrailError(err);
          if (guardrailEvents.length > 0) {
            for (const payload of guardrailEvents) yield payload;
            yield {
              type: "complete",
              result: "Stopped by guardrail",
              attachments: [],
              timestamp: Date.now() / 1000,
            } as SSEEventPayload;
            return;
          }
          throw err;
        }

        let approvalId: string | null = null;
        try {
          for await (const sdkEvent of result) {
            if (isToolApprovalEvent(sdkEvent)) {
              approvalId = approvalIdFromItem(sdkEvent.item);
              if (approvalId) {
                this.registerPendingApproval(approvalId, sdkEvent.item);
              }
            }
            for (const payload of mapAgentsRunStreamEvent(sdkEvent)) {
              await params.onEvent?.(payload);
              yield payload;
            }
          }
          await result.completed;
        } catch (err) {
          if (controller.signal.aborted) {
            this.logger.info("Agents SDK run aborted by interrupt()");
            return;
          }
          const guardrailEvents = mapAgentsGuardrailError(err);
          if (guardrailEvents.length > 0) {
            for (const payload of guardrailEvents) yield payload;
            yield {
              type: "complete",
              result: "Stopped by guardrail",
              attachments: [],
              timestamp: Date.now() / 1000,
            } as SSEEventPayload;
            return;
          }
          throw err;
        } finally {
          this.currentTurn = null;
        }

        const pending = approvalId ? this.pendingApprovals.get(approvalId) : undefined;
        if (pending) {
          await persistRunStateSnapshot(params, result, approvalId);
          const decision = await pending.promise;
          if (this.closed) return;
          if (decision.decision === "approved") {
            result.state.approve(pending.item, {
              ...(decision.options.alwaysApprove !== undefined
                ? { alwaysApprove: decision.options.alwaysApprove }
                : {}),
            });
          } else {
            result.state.reject(pending.item, {
              ...(decision.options.alwaysReject !== undefined
                ? { alwaysReject: decision.options.alwaysReject }
                : {}),
              ...(decision.options.message ? { message: decision.options.message } : {}),
            });
          }
          this.pendingApprovals.delete(approvalId!);
          await persistRunStateSnapshot(params, result, null);
          nextInput = result.state as RunState<any, AnyAgent>;
          continue;
        }

        await params.onRunStateSnapshot?.({
          backendId: "openai-agents",
          serialized: null,
          pendingApprovalId: null,
          previousResponseId: result.lastResponseId ?? statePreviousResponseId(result.state) ?? null,
          conversationId: stateConversationId(result.state) ?? null,
          schemaVersion: AGENTS_RUN_STATE_SCHEMA_VERSION,
        });
        yield {
          type: "complete",
          result: stringifyFinalOutput(result.finalOutput),
          attachments: [],
          timestamp: Date.now() / 1000,
        } as SSEEventPayload;
        return;
      }
    } finally {
      this.currentTurn = null;
      this.running = false;
    }
  }

  deliverToolApproval(
    approvalId: string,
    decision: ToolApprovalDecision,
    options: ToolApprovalDeliveryOptions = {},
  ): ToolApprovalDeliveryResult {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return { status: "approval_not_pending", message: `Approval not pending: ${approvalId}` };
    }
    if (pending.resolved) {
      return { status: "already_resolved", message: `Approval already resolved: ${approvalId}` };
    }
    pending.resolved = true;
    pending.resolve({ decision, options });
    return { status: "delivered" };
  }

  async interrupt(): Promise<boolean> {
    if (this.currentTurn) {
      this.currentTurn.abort();
      return true;
    }
    if (this.pendingApprovals.size === 0) return false;
    this.closed = true;
    for (const pending of this.pendingApprovals.values()) {
      if (!pending.resolved) {
        pending.resolved = true;
        pending.resolve({
          decision: "rejected",
          options: { message: "Session interrupted before tool approval was resolved" },
        });
      }
    }
    return true;
  }

  async close(): Promise<void> {
    const alreadyClosed = this.closed;
    this.closed = true;
    if (!alreadyClosed) {
      if (this.currentTurn) {
        this.currentTurn.abort();
        this.currentTurn = null;
      }
      for (const pending of this.pendingApprovals.values()) {
        if (!pending.resolved) {
          pending.resolved = true;
          pending.resolve({
            decision: "rejected",
            options: { message: "Session closed before tool approval was resolved" },
          });
        }
      }
      this.pendingApprovals.clear();
    }
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    for (const server of this.mcpServers) {
      try {
        await server.close();
      } catch (err) {
        this.logger.warn({ err, server: server.name }, "Agents SDK MCP server close failed");
      }
    }
    if (this.openAIProvider) {
      try {
        await this.openAIProvider.close();
      } catch (err) {
        this.logger.warn({ err }, "OpenAIProvider close failed");
      }
    }
  }

  private async connectMcpServersOnce(): Promise<void> {
    if (this.mcpConnected || this.mcpServers.length === 0) return;
    for (const server of this.mcpServers) {
      await server.connect();
    }
    this.mcpConnected = true;
  }

  private registerPendingApproval(approvalId: string, item: RunToolApprovalItem): void {
    if (this.pendingApprovals.has(approvalId)) return;
    let resolve!: (decision: PendingApprovalDecision) => void;
    const promise = new Promise<PendingApprovalDecision>((res) => {
      resolve = res;
    });
    this.pendingApprovals.set(approvalId, {
      item,
      promise,
      resolved: false,
      resolve,
    });
  }
}

interface AgentGraph {
  agents: Map<string, Agent>;
  mcpServers: MCPServer[];
}

function buildAgentGraph(config: AgentsSdkConfig): AgentGraph {
  const agents = new Map<string, Agent>();
  const mcpServers: MCPServer[] = [];
  for (const agentConfig of config.agents) {
    const agentMcpServers = agentConfig.mcp_servers.map(buildMcpServer);
    mcpServers.push(...agentMcpServers);
    agents.set(agentConfig.id, new Agent({
      name: agentConfig.name,
      instructions: agentConfig.instructions,
      handoffDescription: agentConfig.handoff_description ?? agentConfig.name,
      ...(agentConfig.model ? { model: agentConfig.model } : {}),
      tools: [
        ...agentConfig.tools.map(buildFunctionTool),
        ...agentConfig.hosted_tools.map(buildHostedTool),
      ],
      ...(agentMcpServers.length > 0 ? {
        mcpServers: agentMcpServers,
        mcpConfig: {
          ...(agentConfig.mcp_config?.convert_schemas_to_strict !== undefined
            ? { convertSchemasToStrict: agentConfig.mcp_config.convert_schemas_to_strict }
            : {}),
          ...(agentConfig.mcp_config?.include_server_in_tool_names !== undefined
            ? { includeServerInToolNames: agentConfig.mcp_config.include_server_in_tool_names }
            : {}),
        },
      } : {}),
    }));
  }

  for (const agentConfig of config.agents) {
    const agent = agents.get(agentConfig.id);
    if (!agent) continue;
    agent.handoffs = agentConfig.handoffs.map((targetId) => {
      const target = agents.get(targetId);
      if (!target) {
        throw new Error(`agents_sdk handoff target not found: ${agentConfig.id} -> ${targetId}`);
      }
      return target;
    });
  }
  return { agents, mcpServers };
}

function buildFunctionTool(toolConfig: AgentsSdkConfig["agents"][number]["tools"][number]): Tool {
  return tool({
    name: toolConfig.name,
    description: toolConfig.description,
    parameters: (toolConfig.parameters ?? {
      type: "object",
      properties: {},
      additionalProperties: true,
    }) as never,
    strict: false,
    needsApproval: toolConfig.needs_approval,
    execute: async () => toolConfig.output ?? `${toolConfig.name} executed`,
  }) as Tool;
}

function buildHostedTool(
  toolConfig: AgentsSdkConfig["agents"][number]["hosted_tools"][number],
): Tool {
  switch (toolConfig.type) {
    case "web_search":
      return webSearchTool({
        ...(toolConfig.name ? { name: toolConfig.name } : {}),
        ...(toolConfig.user_location ? { userLocation: toolConfig.user_location as never } : {}),
        ...(toolConfig.allowed_domains
          ? { filters: { allowedDomains: toolConfig.allowed_domains } }
          : {}),
        ...(toolConfig.search_context_size
          ? { searchContextSize: toolConfig.search_context_size }
          : {}),
        ...(toolConfig.external_web_access !== undefined
          ? { externalWebAccess: toolConfig.external_web_access }
          : {}),
      }) as Tool;
    case "file_search":
      return fileSearchTool(toolConfig.vector_store_ids, {
        ...(toolConfig.name ? { name: toolConfig.name } : {}),
        ...(toolConfig.max_num_results !== undefined
          ? { maxNumResults: toolConfig.max_num_results }
          : {}),
        ...(toolConfig.include_search_results !== undefined
          ? { includeSearchResults: toolConfig.include_search_results }
          : {}),
        ...(toolConfig.ranking_options ? { rankingOptions: toolConfig.ranking_options as never } : {}),
        ...(toolConfig.filters ? { filters: toolConfig.filters as never } : {}),
      }) as Tool;
    case "code_interpreter":
      return codeInterpreterTool({
        ...(toolConfig.name ? { name: toolConfig.name } : {}),
        ...(toolConfig.include_outputs !== undefined
          ? { includeOutputs: toolConfig.include_outputs }
          : {}),
        ...(toolConfig.container ? { container: toolConfig.container as never } : {}),
      }) as Tool;
    case "tool_search":
      return toolSearchTool({
        ...(toolConfig.name ? { name: toolConfig.name as "tool_search" } : {}),
        ...(toolConfig.description !== undefined ? { description: toolConfig.description } : {}),
        ...(toolConfig.parameters !== undefined ? { parameters: toolConfig.parameters } : {}),
      }) as Tool;
    case "image_generation":
      return imageGenerationTool({
        ...(toolConfig.name ? { name: toolConfig.name } : {}),
        ...(toolConfig.background ? { background: toolConfig.background } : {}),
        ...(toolConfig.input_fidelity !== undefined
          ? { inputFidelity: toolConfig.input_fidelity }
          : {}),
        ...(toolConfig.input_image_mask ? { inputImageMask: toolConfig.input_image_mask as never } : {}),
        ...(toolConfig.model ? { model: toolConfig.model } : {}),
        ...(toolConfig.moderation ? { moderation: toolConfig.moderation } : {}),
        ...(toolConfig.output_compression !== undefined
          ? { outputCompression: toolConfig.output_compression }
          : {}),
        ...(toolConfig.output_format ? { outputFormat: toolConfig.output_format } : {}),
        ...(toolConfig.partial_images !== undefined ? { partialImages: toolConfig.partial_images } : {}),
        ...(toolConfig.quality ? { quality: toolConfig.quality } : {}),
        ...(toolConfig.size ? { size: toolConfig.size } : {}),
      }) as Tool;
    case "hosted_mcp":
      return hostedMcpTool({
        serverLabel: toolConfig.server_label,
        ...(toolConfig.server_url ? { serverUrl: toolConfig.server_url } : {}),
        ...(toolConfig.connector_id ? { connectorId: toolConfig.connector_id } : {}),
        ...(toolConfig.authorization ? { authorization: toolConfig.authorization } : {}),
        ...(toolConfig.headers ? { headers: toolConfig.headers } : {}),
        ...(toolConfig.allowed_tools ? { allowedTools: toolConfig.allowed_tools } : {}),
        ...(toolConfig.defer_loading !== undefined ? { deferLoading: toolConfig.defer_loading } : {}),
        ...(toolConfig.server_description ? { serverDescription: toolConfig.server_description } : {}),
        ...(toolConfig.require_approval !== undefined
          ? { requireApproval: mapHostedMcpApproval(toolConfig.require_approval) }
          : {}),
      } as never) as Tool;
  }
}

function buildMcpServer(
  config: AgentsSdkConfig["agents"][number]["mcp_servers"][number],
): MCPServer {
  switch (config.type) {
    case "stdio": {
      const base = {
        ...(config.name ? { name: config.name } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.cache_tools_list !== undefined ? { cacheToolsList: config.cache_tools_list } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      };
      if (config.full_command) {
        return new MCPServerStdio({ ...base, fullCommand: config.full_command });
      }
      return new MCPServerStdio({ ...base, command: config.command!, args: config.args });
    }
    case "streamable_http":
      return new MCPServerStreamableHttp({
        url: config.url,
        ...(config.name ? { name: config.name } : {}),
        ...(config.cache_tools_list !== undefined ? { cacheToolsList: config.cache_tools_list } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
        ...(config.session_id ? { sessionId: config.session_id } : {}),
        ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
      });
    case "sse":
      return new MCPServerSSE({
        url: config.url,
        ...(config.name ? { name: config.name } : {}),
        ...(config.cache_tools_list !== undefined ? { cacheToolsList: config.cache_tools_list } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
        ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
      });
  }
}

function buildOpenAIProvider(
  config: AgentsSdkConfig,
  processEnv: NodeJS.ProcessEnv,
): OpenAIProvider | undefined {
  const provider = config.provider;
  if (!provider) return undefined;
  const apiKey = provider.api_key_env ? processEnv[provider.api_key_env] : undefined;
  if (provider.api_key_env && !apiKey) {
    throw new Error(`agents_sdk.provider.api_key_env missing from process env: ${provider.api_key_env}`);
  }
  return new OpenAIProvider({
    ...(apiKey ? { apiKey } : {}),
    ...(provider.base_url ? { baseURL: provider.base_url } : {}),
    ...(provider.websocket_base_url ? { websocketBaseURL: provider.websocket_base_url } : {}),
    ...(provider.organization ? { organization: provider.organization } : {}),
    ...(provider.project ? { project: provider.project } : {}),
    ...(provider.use_responses !== undefined ? { useResponses: provider.use_responses } : {}),
    ...(provider.use_responses_websocket !== undefined
      ? { useResponsesWebSocket: provider.use_responses_websocket }
      : {}),
    ...(provider.strict_feature_validation !== undefined
      ? { strictFeatureValidation: provider.strict_feature_validation }
      : {}),
    ...(provider.cache_responses_websocket_models !== undefined
      ? { cacheResponsesWebSocketModels: provider.cache_responses_websocket_models }
      : {}),
  });
}

function mapHostedMcpApproval(
  value: NonNullable<
    Extract<
      AgentsSdkConfig["agents"][number]["hosted_tools"][number],
      { type: "hosted_mcp" }
    >["require_approval"]
  >,
): unknown {
  if (value === "never" || value === "always") return value;
  return {
    ...(value.never ? {
      never: {
        ...(value.never.tool_names ? { toolNames: value.never.tool_names } : {}),
        ...(value.never.read_only !== undefined ? { readOnly: value.never.read_only } : {}),
      },
    } : {}),
    ...(value.always ? {
      always: {
        ...(value.always.tool_names ? { toolNames: value.always.tool_names } : {}),
        ...(value.always.read_only !== undefined ? { readOnly: value.always.read_only } : {}),
      },
    } : {}),
  };
}

class SoulstreamAgentsSession implements Session {
  private items: AgentInputItem[];

  constructor(
    private readonly sessionId: string,
    initialItems: unknown[] | undefined,
    private readonly onSnapshot: SessionItemsSnapshotCallback | undefined,
  ) {
    this.items = (initialItems ?? []) as AgentInputItem[];
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = limit && limit > 0 ? this.items.slice(-limit) : this.items;
    return [...items];
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.items = [...this.items, ...items];
    await this.persist();
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = this.items.pop();
    await this.persist();
    return item;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.onSnapshot?.({
      backendId: "openai-agents",
      items: [...this.items],
    });
  }
}

async function persistRunStateSnapshot(
  params: EngineExecuteParams,
  result: StreamedRunResult<any, AnyAgent>,
  pendingApprovalId: string | null,
): Promise<void> {
  await params.onRunStateSnapshot?.({
    backendId: "openai-agents",
    serialized: result.state.toString(),
    pendingApprovalId,
    previousResponseId: result.lastResponseId ?? statePreviousResponseId(result.state) ?? null,
    conversationId: stateConversationId(result.state) ?? null,
    schemaVersion: AGENTS_RUN_STATE_SCHEMA_VERSION,
  });
}

function applyQueuedToolApproval(
  state: RunState<any, AnyAgent>,
  queued: QueuedToolApprovalDecision,
): void {
  const approvalItem = state.getInterruptions().find((item) =>
    approvalIdFromItem(item) === queued.approvalId
  );
  if (!approvalItem) {
    throw new Error(`Queued approval not found in RunState: ${queued.approvalId}`);
  }
  if (queued.decision === "approved") {
    state.approve(approvalItem, {
      ...(queued.options?.alwaysApprove !== undefined
        ? { alwaysApprove: queued.options.alwaysApprove }
        : {}),
    });
    return;
  }
  state.reject(approvalItem, {
    ...(queued.options?.alwaysReject !== undefined
      ? { alwaysReject: queued.options.alwaysReject }
      : {}),
    ...(queued.options?.message ? { message: queued.options.message } : {}),
  });
}

function statePreviousResponseId(state: RunState<any, AnyAgent>): string | undefined {
  const value = (state as unknown as { _previousResponseId?: unknown })._previousResponseId;
  return typeof value === "string" ? value : undefined;
}

function stateConversationId(state: RunState<any, AnyAgent>): string | undefined {
  const value = (state as unknown as { _conversationId?: unknown })._conversationId;
  return typeof value === "string" ? value : undefined;
}

function buildInputGuardrails(config: AgentsSdkConfig): Agent["inputGuardrails"] {
  return config.guardrails.input_blocklist.map((guardrail) => ({
    name: guardrail.name,
    runInParallel: false,
    execute: async ({ input }) => {
      const text = typeof input === "string" ? input : JSON.stringify(input);
      const matched = new RegExp(guardrail.pattern, "i").exec(text)?.[0];
      return {
        tripwireTriggered: Boolean(matched),
        outputInfo: matched
          ? { matched, message: guardrail.message ?? `Blocked by ${guardrail.name}` }
          : null,
      };
    },
  }));
}

function buildOutputGuardrails(config: AgentsSdkConfig): Agent["outputGuardrails"] {
  return config.guardrails.output_blocklist.map((guardrail) => ({
    name: guardrail.name,
    execute: async ({ agentOutput }) => {
      const text = typeof agentOutput === "string" ? agentOutput : JSON.stringify(agentOutput);
      const matched = new RegExp(guardrail.pattern, "i").exec(text)?.[0];
      return {
        tripwireTriggered: Boolean(matched),
        outputInfo: matched
          ? { matched, message: guardrail.message ?? `Blocked by ${guardrail.name}` }
          : null,
      };
    },
  }));
}

function isToolApprovalEvent(event: unknown): event is {
  type: "run_item_stream_event";
  name: "tool_approval_requested";
  item: RunToolApprovalItem;
} {
  return Boolean(
    event &&
      typeof event === "object" &&
      (event as { type?: unknown }).type === "run_item_stream_event" &&
      (event as { name?: unknown }).name === "tool_approval_requested" &&
      (event as { item?: unknown }).item,
  );
}

function approvalIdFromItem(item: RunToolApprovalItem): string {
  const raw = item.rawItem as { callId?: string; call_id?: string; id?: string };
  return raw.callId ?? raw.call_id ?? raw.id ?? "";
}

function stringifyFinalOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "Run completed";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
