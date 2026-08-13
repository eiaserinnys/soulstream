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
import { normalizeRunnerInterventionResult } from "./runner_intervention_result.js";
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
    return normalizeRunnerInterventionResult(result);
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
