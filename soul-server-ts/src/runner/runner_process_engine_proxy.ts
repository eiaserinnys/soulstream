import type {
  BackendId,
  ClaudeBackgroundTaskControlResult,
  EngineExecuteParams,
  EngineInterventionResult,
  EnginePort,
  EngineUserInput,
  InputResponseDeliveryResult,
  SSEEventPayload,
  ToolApprovalDecision,
  ToolApprovalDeliveryOptions,
  ToolApprovalDeliveryResult,
} from "../engine/protocol.js";
import { sseEventsFromRunnerFrames } from "./engine_event_stream.js";
import type { RunnerProcessDispatcher } from "./runner_process_dispatcher.js";

/** Adapts the process command dispatcher to the existing EnginePort surface. */
export class RunnerProcessEngineProxy implements EnginePort {
  readonly detachedClaudeRuntime: true | undefined;

  constructor(
    readonly backendId: BackendId,
    readonly workspaceDir: string,
    private readonly dispatcher: RunnerProcessDispatcher,
  ) {
    this.detachedClaudeRuntime = backendId === "claude" ? true : undefined;
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    yield* sseEventsFromRunnerFrames(this.dispatcher.executeFrames(params));
  }

  async interrupt(): Promise<boolean> { return await this.dispatcher.interrupt(); }
  async close(): Promise<void> { await this.dispatcher.close(); }
  async compact(sessionId: string): Promise<void> {
    await this.dispatcher.invoke("compact", [sessionId]);
  }
  async intervene(input: EngineUserInput): Promise<EngineInterventionResult> {
    const result = await this.dispatcher.invoke("intervene", [input]);
    return normalizeInterventionResult(result);
  }
  async deliverInputResponse(
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<InputResponseDeliveryResult> {
    return await this.dispatcher.invoke(
      "deliverInputResponse",
      [requestId, answers],
    ) as InputResponseDeliveryResult;
  }
  async deliverToolApproval(
    approvalId: string,
    decision: ToolApprovalDecision,
    options?: ToolApprovalDeliveryOptions,
  ): Promise<ToolApprovalDeliveryResult> {
    return await this.dispatcher.invoke(
      "deliverToolApproval",
      [approvalId, decision, options ?? {}],
    ) as ToolApprovalDeliveryResult;
  }
  async backgroundClaudeRuntimeTasks(toolUseId?: string): Promise<ClaudeBackgroundTaskControlResult> {
    return await this.dispatcher.invoke(
      "backgroundClaudeRuntimeTasks",
      [toolUseId],
    ) as ClaudeBackgroundTaskControlResult;
  }
  async stopClaudeRuntimeTask(taskId: string): Promise<ClaudeBackgroundTaskControlResult> {
    return await this.dispatcher.invoke(
      "stopClaudeRuntimeTask",
      [taskId],
    ) as ClaudeBackgroundTaskControlResult;
  }
}

function normalizeInterventionResult(result: unknown): EngineInterventionResult {
  if (
    isRecord(result)
    && result.status === "delivered"
    && isInterventionMechanism(result.mechanism)
  ) {
    return {
      status: "delivered",
      mechanism: result.mechanism,
    };
  }
  if (
    isRecord(result)
    && result.status === "not_delivered"
    && isInterventionMechanism(result.mechanism)
    && isInterventionFailureReason(result.reason)
  ) {
    return {
      status: "not_delivered",
      mechanism: result.mechanism,
      reason: result.reason,
      ...(typeof result.message === "string" ? { message: result.message } : {}),
    };
  }
  if (isRecord(result) && result.status === "not_supported") {
    return {
      status: "not_delivered",
      mechanism: "unsupported",
      reason: "not_supported",
      message: "Runner child does not expose the intervention operation",
    };
  }
  return {
    status: "not_delivered",
    mechanism: "unsupported",
    reason: "failed",
    message: "Runner child returned an invalid intervention result",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInterventionMechanism(
  value: unknown,
): value is EngineInterventionResult["mechanism"] {
  return value === "active_turn"
    || value === "interrupt_then_next_turn"
    || value === "unsupported";
}

function isInterventionFailureReason(
  value: unknown,
): value is Extract<EngineInterventionResult, { status: "not_delivered" }>["reason"] {
  return value === "not_supported"
    || value === "no_active_turn"
    || value === "not_accepting_input"
    || value === "turn_mismatch"
    || value === "failed"
    || value === "next_turn_required";
}
