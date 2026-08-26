import type {
  BackendId,
  ClaudeBackgroundTaskControlResult,
  DetachedClaudeRuntimeActivity,
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
    options: { retainDetachedRuntime?: boolean } = {},
  ) {
    this.detachedClaudeRuntime = backendId === "claude"
      && options.retainDetachedRuntime !== false
      ? true
      : undefined;
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    yield* sseEventsFromRunnerFrames(this.dispatcher.executeFrames(params));
  }

  async interrupt(): Promise<boolean> { return await this.dispatcher.interrupt(); }
  async close(): Promise<void> { await this.dispatcher.close(); }
  async compact(sessionId: string): Promise<void> {
    await this.dispatcher.invoke("compact", [sessionId], "turn");
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
  async detachedClaudeRuntimeActivity(): Promise<DetachedClaudeRuntimeActivity | null> {
    const result = await this.dispatcher.invoke("detachedClaudeRuntimeActivity", []);
    if (isUnavailableDetachedClaudeRuntimeActivity(result)) return null;
    if (!isDetachedClaudeRuntimeActivity(result)) {
      throw new Error("Runner child returned invalid detached Claude runtime activity");
    }
    return result;
  }
  async stopClaudeRuntimeTask(taskId: string): Promise<ClaudeBackgroundTaskControlResult> {
    return await this.dispatcher.invoke(
      "stopClaudeRuntimeTask",
      [taskId],
    ) as ClaudeBackgroundTaskControlResult;
  }
}

function isUnavailableDetachedClaudeRuntimeActivity(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).status === "not_supported";
}

function isDetachedClaudeRuntimeActivity(
  value: unknown,
): value is DetachedClaudeRuntimeActivity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const activity = value as Record<string, unknown>;
  return typeof activity.foregroundPhase === "string"
    && typeof activity.queryLifecycle === "string"
    && isCount(activity.backgroundTaskCount)
    && isCount(activity.pendingInputRequestCount)
    && (activity.pendingRuntimeSignalCount === undefined
      || isCount(activity.pendingRuntimeSignalCount));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
