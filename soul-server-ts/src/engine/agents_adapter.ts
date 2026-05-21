import { randomUUID } from "node:crypto";

import {
  Agent,
  Runner,
  tool,
  type RunState,
  type RunToolApprovalItem,
  type StreamedRunResult,
  type Tool,
} from "@openai/agents";
import type { Logger } from "pino";

import type { AgentProfile, AgentsSdkConfig } from "../agent_registry.js";

import { mapAgentsGuardrailError, mapAgentsRunStreamEvent } from "./agents_event_mapper.js";
import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
  SupportsToolApproval,
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

export interface AgentsAdapterConfig {
  workspaceDir: string;
  profile: AgentProfile;
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
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private currentTurn: AbortController | null = null;
  private closed = false;
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
    const entry = graph.get(config.profile.agents_sdk.entry_agent);
    if (!entry) {
      throw new Error(
        `agents_sdk.entry_agent not found: ${config.profile.agents_sdk.entry_agent}`,
      );
    }
    this.entryAgent = entry;
    this.maxTurns = config.profile.agents_sdk.max_turns ?? config.profile.max_turns;
    this.runner = new Runner({
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

    let nextInput: string | RunState<any, AnyAgent> = params.prompt;
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
          const decision = await pending.promise;
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
          nextInput = result.state as RunState<any, AnyAgent>;
          continue;
        }

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
    if (!this.currentTurn) return false;
    this.currentTurn.abort();
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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

function buildAgentGraph(config: AgentsSdkConfig): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  for (const agentConfig of config.agents) {
    agents.set(agentConfig.id, new Agent({
      name: agentConfig.name,
      instructions: agentConfig.instructions,
      handoffDescription: agentConfig.handoff_description ?? agentConfig.name,
      ...(agentConfig.model ? { model: agentConfig.model } : {}),
      tools: agentConfig.tools.map(buildFunctionTool),
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
  return agents;
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
