import type { AgentProfile } from "../agent_registry.js";
import type { ExecutionInputV1, UsageSnapshotV1 } from "@soulstream/wire-schema";
import type { UsageStatsProvider } from "@soulstream/wire-schema/session-statistics";
import type {
  EngineExecuteParams,
  EnginePort,
  EngineRunStateSnapshot,
  EngineSessionItemsSnapshot,
  ScheduleToolUseHandler,
  SSEEventPayload,
  TurnOrigin,
} from "../engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../engine/claude_options.js";
import { fatalErrorFromRunnerFrame, sseEventFromRunnerFrame } from "../runner/engine_event_stream.js";
import { DEFAULT_RUNNER_REQUEST_TIMEOUT_MS } from "../runner/in_process_frame_channel.js";
import {
  runnerControlResponseFrame,
  type RunnerEventFrame,
} from "../runner/frame_protocol.js";
import type { RunnerCommandDispatcher } from "../runner/runner_command_dispatcher.js";
import type { TaskRunnerRuntime } from "../runner/task_runner_runtime.js";
import {
  ANTHROPIC_API_KEY_ENV,
  resolveModelPresetEnv,
} from "../model_preset_env.js";
import {
  findModelProvider,
  resolvePresetProvider,
  type ModelCatalogConfig,
} from "@soulstream/model-catalog";

import type { ModelCatalog } from "../model_catalog.js";
import type { Task } from "./task_models.js";
import {
  effectiveTaskBackend,
  resolveOpenCodeMcpToolAllowlist,
} from "./task_model_preset.js";
import { resolveTurnReasoningEffort } from "./session_effort_storage.js";

export interface TaskEngineTurnInput {
  prompt: string;
  inputMaterialParts?: ExecutionInputV1["parts"];
  inputUuid?: string;
  runnerInterventionId?: string;
  runnerInterventionIds?: string[];
  turnOrigin?: TurnOrigin;
  imageAttachmentPaths?: string[];
  systemPrompt?: string;
  backendSessionRolloverFrom?: string;
}

export interface TaskEngineTurnRunnerDeps {
  snapshotPersistence: TaskAgentsSnapshotPersistencePort;
  scheduleToolHandler?: ScheduleToolUseHandler;
  modelCatalog?: Pick<ModelCatalog, "resolve" | "snapshot">;
  claudeAccountPoolEnabled?: boolean;
}

export interface TaskAgentsSnapshotPersistencePort {
  persistRunStateSnapshot(task: Task, snapshot: EngineRunStateSnapshot): Promise<void>;
  persistSessionItemsSnapshot(task: Task, snapshot: EngineSessionItemsSnapshot): Promise<void>;
}

export interface TaskEngineTurnRunnerParams {
  task: Task;
  agent: AgentProfile;
  runner: TaskRunnerRuntime;
  input: TaskEngineTurnInput;
}

/**
 * Usage attribution comes from catalogue data first: the recorded preset, then
 * the runtime model string (preset model or model-row alias). Backend family
 * rules only cover strings the catalogue does not know.
 */
function usageProviderForExecution(
  backend: AgentProfile["backend"],
  model: string | null,
  presetId: string | null | undefined,
  catalog: ModelCatalogConfig | undefined,
): UsageStatsProvider {
  if (catalog && presetId) {
    const preset = catalog.presets.find((candidate) => candidate.id === presetId);
    if (preset) return resolvePresetProvider(preset);
  }
  if (catalog && model) {
    const provider = findModelProvider(catalog, model);
    if (provider !== undefined) return provider;
  }
  if (backend === "codex") return "codex";
  if (backend === "antigravity") return "antigravity";
  if (backend === "claude" && model?.startsWith("claude-")) return "claude";
  return "unknown";
}

function buildClaudeExtraEnv(params: {
  profileEnv?: Record<string, string>;
  oauthToken?: string;
  processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sourceLabel?: string;
}): Record<string, string> | undefined {
  const extraEnv: Record<string, string> = {
    ...(resolveModelPresetEnv(
      params.profileEnv,
      params.processEnv ?? process.env,
      params.sourceLabel,
    ) ?? {}),
  };
  if (params.oauthToken && !(ANTHROPIC_API_KEY_ENV in extraEnv)) {
    extraEnv[CLAUDE_OAUTH_TOKEN_ENV] = params.oauthToken;
  }
  return Object.keys(extraEnv).length > 0 ? extraEnv : undefined;
}

/**
 * Owns the boundary between Task runtime state and one EnginePort.execute turn.
 *
 * TaskExecutor decides when turns start and how yielded events are drained; this class decides
 * which task/agent runtime policy is consumed or forwarded for that single turn.
 */
interface ResolvedTurnPolicy {
  backend: ReturnType<typeof effectiveTaskBackend>;
  provider: UsageStatsProvider;
  effectiveModel: AgentProfile["model"];
  turnReasoningEffort: ReturnType<typeof resolveTurnReasoningEffort>;
  effectiveAllowedTools: AgentProfile["allowed_tools"];
  effectiveDisallowedTools: AgentProfile["disallowed_tools"];
  effectiveClaudePermissionMode: AgentProfile["claude_permission_mode"];
  opencodeMcpToolAllowlist: ReturnType<typeof resolveOpenCodeMcpToolAllowlist>;
  claudeAccountPoolTarget: boolean;
  extraEnv: Record<string, string> | undefined;
}

export class TaskEngineTurnRunner {
  constructor(private readonly deps: TaskEngineTurnRunnerDeps) {}

  /**
   * Task/agent runtime policy consumed by one Claude run. Shared by normal
   * turns and by compact fallback params so a compact that has to spawn a new
   * client resolves the same env, account pool, model and effort.
   */
  private resolveTurnPolicy(
    task: Task,
    agent: AgentProfile,
    engineBackendId: AgentProfile["backend"],
  ): ResolvedTurnPolicy {
    // Single legacy-compat boundary: the effective backend is known here, so a
    // pre-089 unrecorded row can replay exactly what it used to get.
    const turnReasoningEffort = resolveTurnReasoningEffort(
      {
        recorded: task.reasoningEffortRecorded === true,
        ...(task.reasoningEffort !== undefined
          ? { effort: task.reasoningEffort }
          : {}),
      },
      effectiveTaskBackend(task, agent),
    );
    const effectiveModel = task.model ?? agent.model;
    const backend = effectiveTaskBackend(task, agent);
    const provider = usageProviderForExecution(
      backend,
      effectiveModel ?? null,
      task.modelPreset,
      this.deps.modelCatalog?.snapshot(),
    );
    const opencodeMcpToolAllowlist = resolveOpenCodeMcpToolAllowlist(
      task,
      agent,
      this.deps.modelCatalog,
    );
    const hasResolvedPreset = task.modelPresetBackend !== undefined;
    const claudeProfileEnv = engineBackendId === "claude"
      ? buildClaudeExtraEnv({
          profileEnv: hasResolvedPreset ? (task.modelPresetEnv ?? {}) : agent.env,
          sourceLabel: hasResolvedPreset ? "model preset" : "agents.yaml",
        })
      : undefined;
    // Pool targeting follows the resolved provider and endpoint, not the model
    // spelling: official presets use aliases such as "opus" or "haiku", which the
    // usage provider classifier reports as "unknown". Third-party Anthropic-compatible
    // endpoints (Kimi and any ANTHROPIC_BASE_URL override) stay on their env path.
    const claudeAccountPoolTarget = this.deps.claudeAccountPoolEnabled === true
      && backend === "claude"
      && provider !== "kimi"
      && claudeProfileEnv?.ANTHROPIC_BASE_URL === undefined;
    const claudeExtraEnv = engineBackendId === "claude"
      ? {
          ...(claudeProfileEnv ?? {}),
          ...(!claudeAccountPoolTarget
            && task.oauthToken
            && !(ANTHROPIC_API_KEY_ENV in (claudeProfileEnv ?? {}))
            ? { [CLAUDE_OAUTH_TOKEN_ENV]: task.oauthToken }
            : {}),
        }
      : undefined;
    const extraEnv = claudeExtraEnv && Object.keys(claudeExtraEnv).length > 0
      ? claudeExtraEnv
      : undefined;
    return {
      backend,
      provider,
      effectiveModel,
      turnReasoningEffort,
      effectiveAllowedTools: task.allowedTools ?? agent.allowed_tools,
      effectiveDisallowedTools: task.disallowedTools ?? agent.disallowed_tools,
      effectiveClaudePermissionMode: task.claudePermissionMode ?? agent.claude_permission_mode,
      opencodeMcpToolAllowlist,
      claudeAccountPoolTarget,
      extraEnv,
    };
  }

  /**
   * Fallback run params for a compact that must spawn a fresh client (no active
   * client in this process). The compact itself performs no turn, so the prompt
   * only satisfies the execute-params contract.
   */
  buildCompactExecuteParams(
    task: Task,
    agent: AgentProfile,
    turnInput?: TaskEngineTurnInput,
  ): EngineExecuteParams {
    const policy = this.resolveTurnPolicy(task, agent, effectiveTaskBackend(task, agent));
    return {
      agentSessionId: task.agentSessionId,
      prompt: turnInput?.prompt ?? "",
      sessionCost: task.sessionCost ?? {
        usd: 0,
        partial: task.codexThreadId !== undefined,
      },
      ...(task.executionSecurity ? { executionSecurity: task.executionSecurity } : {}),
      ...(turnInput?.inputUuid ? { inputUuid: turnInput.inputUuid } : {}),
      ...(turnInput?.turnOrigin ? { turnOrigin: turnInput.turnOrigin } : {}),
      ...(turnInput?.imageAttachmentPaths !== undefined
        ? { imageAttachmentPaths: turnInput.imageAttachmentPaths }
        : {}),
      ...(policy.effectiveModel !== undefined ? { model: policy.effectiveModel } : {}),
      ...(policy.turnReasoningEffort !== undefined
        ? { reasoningEffort: policy.turnReasoningEffort }
        : {}),
      ...(turnInput?.systemPrompt !== undefined
        ? { systemPrompt: turnInput.systemPrompt }
        : {}),
      ...(policy.effectiveAllowedTools !== undefined
        ? { allowedTools: policy.effectiveAllowedTools }
        : {}),
      ...(policy.effectiveDisallowedTools !== undefined
        ? { disallowedTools: policy.effectiveDisallowedTools }
        : {}),
      ...(task.useMcp !== undefined ? { useMcp: task.useMcp } : {}),
      ...(policy.opencodeMcpToolAllowlist !== undefined
        ? { opencodeMcpToolAllowlist: policy.opencodeMcpToolAllowlist }
        : {}),
      ...(policy.effectiveClaudePermissionMode !== undefined
        ? { claudePermissionMode: policy.effectiveClaudePermissionMode }
        : {}),
      ...(agent.claude_auto_memory_enabled !== undefined
        ? { claudeAutoMemoryEnabled: agent.claude_auto_memory_enabled }
        : {}),
      ...(agent.max_turns !== undefined ? { maxTurns: agent.max_turns } : {}),
      ...(policy.extraEnv !== undefined ? { extraEnv: policy.extraEnv } : {}),
      ...(this.deps.scheduleToolHandler !== undefined
        ? { scheduleToolUseEnabled: true }
        : {}),
      ...(policy.claudeAccountPoolTarget ? { claudeAccountPoolTarget: true } : {}),
    };
  }

  executeTurn({
    task,
    agent,
    runner,
    input,
  }: TaskEngineTurnRunnerParams): AsyncIterable<SSEEventPayload> {
    const { engine, dispatcher } = runner;
    const queuedToolApproval = task.agentsQueuedToolApproval;
    task.agentsQueuedToolApproval = undefined;

    const policy = this.resolveTurnPolicy(task, agent, engine.backendId);
    const {
      backend,
      provider,
      effectiveModel,
      turnReasoningEffort,
      effectiveAllowedTools,
      effectiveDisallowedTools,
      effectiveClaudePermissionMode,
      opencodeMcpToolAllowlist,
      claudeAccountPoolTarget,
      extraEnv,
    } = policy;

    const executeParams: EngineExecuteParams = {
      agentSessionId: task.agentSessionId,
      prompt: input.prompt,
      sessionCost: task.sessionCost ?? {
        usd: 0,
        partial: task.codexThreadId !== undefined,
      },
      // 격리 판정은 TaskExecutor가 턴 시작 때 한 번 계산해 task에 둔다.
      // off거나 LLM 세션이면 필드 자체가 없다.
      ...(task.executionSecurity ? { executionSecurity: task.executionSecurity } : {}),
      ...(input.inputUuid ? { inputUuid: input.inputUuid } : {}),
      ...(input.runnerInterventionId
        ? { runnerInterventionId: input.runnerInterventionId }
        : {}),
      ...(input.runnerInterventionIds
        ? { runnerInterventionIds: input.runnerInterventionIds }
        : {}),
      ...(input.turnOrigin ? { turnOrigin: input.turnOrigin } : {}),
      ...(input.imageAttachmentPaths !== undefined
        ? { imageAttachmentPaths: input.imageAttachmentPaths }
        : {}),
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(turnReasoningEffort !== undefined
        ? { reasoningEffort: turnReasoningEffort }
        : {}),
      ...(input.backendSessionRolloverFrom !== undefined
        ? { backendSessionRolloverFrom: input.backendSessionRolloverFrom }
        : task.codexThreadId !== undefined
          ? { resumeSessionId: task.codexThreadId }
          : {}),
      ...(task.agentsRunState !== undefined ? { resumeRunState: task.agentsRunState } : {}),
      ...(task.agentsPreviousResponseId !== undefined
        ? { previousResponseId: task.agentsPreviousResponseId }
        : {}),
      ...(task.agentsConversationId !== undefined
        ? { conversationId: task.agentsConversationId }
        : {}),
      ...(task.agentsSessionItems !== undefined ? { sessionItems: task.agentsSessionItems } : {}),
      ...(queuedToolApproval ? { queuedToolApproval } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(effectiveAllowedTools !== undefined ? { allowedTools: effectiveAllowedTools } : {}),
      ...(effectiveDisallowedTools !== undefined
        ? { disallowedTools: effectiveDisallowedTools }
        : {}),
      ...(task.useMcp !== undefined ? { useMcp: task.useMcp } : {}),
      ...(opencodeMcpToolAllowlist !== undefined
        ? { opencodeMcpToolAllowlist }
        : {}),
      ...(effectiveClaudePermissionMode !== undefined
        ? { claudePermissionMode: effectiveClaudePermissionMode }
        : {}),
      ...(agent.claude_auto_memory_enabled !== undefined
        ? { claudeAutoMemoryEnabled: agent.claude_auto_memory_enabled }
        : {}),
      ...(agent.max_turns !== undefined ? { maxTurns: agent.max_turns } : {}),
      ...(extraEnv !== undefined ? { extraEnv } : {}),
      ...(this.deps.scheduleToolHandler !== undefined
        ? { scheduleToolUseEnabled: true }
        : {}),
      ...(claudeAccountPoolTarget ? { claudeAccountPoolTarget: true } : {}),
    };
    const usageSnapshot: UsageSnapshotV1 = {
      schema_version: 1,
      backend,
      provider,
      preset_id: task.modelPreset ?? null,
      requested_model: effectiveModel ?? null,
      provider_attribution: provider === "unknown" ? "unknown" : "configured_alias",
    };
    const inputMaterialParts = input.inputMaterialParts ?? null;
    const resumed = executeParams.resumeSessionId !== undefined
      || executeParams.resumeRunState !== undefined
      || executeParams.previousResponseId !== undefined
      || executeParams.conversationId !== undefined
      || executeParams.sessionItems !== undefined;
    const replayed = Boolean(input.backendSessionRolloverFrom)
      || inputMaterialParts?.some((part) => part.category === "history_replay") === true;
    const nonComparableReasons: ExecutionInputV1["non_comparable_reasons"] = [
      "hidden_system_or_schema",
      "missing_source_token_breakdown",
    ];
    if (inputMaterialParts === null) {
      nonComparableReasons.push("material_breakdown_unavailable");
    }
    if (resumed || replayed) nonComparableReasons.push("replayed_history");
    const executionInput: ExecutionInputV1 = {
      schema_version: 1,
      command_id: null,
      input_id: input.inputUuid ?? null,
      scope: "newly_observed_material",
      stage: "prepared",
      resumed,
      replayed,
      scope_match: "unverified",
      non_comparable_reasons: nonComparableReasons,
      estimate_method: "utf16_chars_div4_ceil_v1",
      parts: inputMaterialParts,
    };
    const frames = dispatcher.executeFrames({
      ...executeParams,
      usage_snapshot: usageSnapshot,
      execution_input: executionInput,
    });

    return consumeRunnerFrames(frames, {
      task,
      runnerCommandDispatcher: dispatcher,
      snapshotPersistence: this.deps.snapshotPersistence,
      scheduleToolHandler: this.deps.scheduleToolHandler,
    });
  }

  recoverTurn(
    task: Task,
    runner: TaskRunnerRuntime,
    frames: AsyncIterable<RunnerEventFrame>,
  ): AsyncIterable<SSEEventPayload> {
    return consumeRunnerFrames(frames, {
      task,
      runnerCommandDispatcher: runner.dispatcher,
      snapshotPersistence: this.deps.snapshotPersistence,
      scheduleToolHandler: this.deps.scheduleToolHandler,
    });
  }
}

export async function* consumeRunnerFrames(
  frames: AsyncIterable<RunnerEventFrame>,
  deps: {
    task: Task;
    runnerCommandDispatcher: RunnerCommandDispatcher;
    snapshotPersistence: TaskAgentsSnapshotPersistencePort;
    scheduleToolHandler?: ScheduleToolUseHandler;
  },
): AsyncIterable<SSEEventPayload> {
  let fatalError: Error | undefined;
  for await (const frame of frames) {
    if (frame.kind === "engine_event") {
      fatalError = fatalErrorFromRunnerFrame(frame) ?? fatalError;
      yield sseEventFromRunnerFrame(frame);
      continue;
    }
    if (frame.kind === "run_state_snapshot") {
      await deps.snapshotPersistence.persistRunStateSnapshot(deps.task, frame.snapshot);
      continue;
    }
    if (frame.kind === "session_items_snapshot") {
      await deps.snapshotPersistence.persistSessionItemsSnapshot(deps.task, frame.snapshot);
      continue;
    }
    if (
      frame.request.kind === "can_use_tool" ||
      frame.request.kind === "tool_approval"
    ) {
      // AskUserQuestion and tool approvals are resolved asynchronously through
      // the existing delivery route. The request frame only makes that runner
      // boundary explicit; it does not add another wire event or ACK.
      continue;
    }
    if (frame.request.kind === "host_call") {
      throw new Error("Runner host_call leaked past the process dispatcher");
    }
    if (!deps.scheduleToolHandler) {
      throw new Error("Runner emitted schedule request without a host control boundary");
    }
    const timeoutMs = frame.timeoutMs ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS;
    const channelContext = deps.runnerCommandDispatcher.requestContext(frame.correlationId);
    const fallbackLifetime = channelContext ? undefined : createTimeoutLifetime(timeoutMs);
    const signal = channelContext?.signal ?? fallbackLifetime!.signal;
    let response: ReturnType<typeof runnerControlResponseFrame>;
    try {
      const result = await raceWithSignal(deps.scheduleToolHandler({
        agentSessionId: frame.request.agentSessionId,
        toolUseId: frame.request.toolUseId,
        toolName: frame.request.toolName,
        input: frame.request.input,
        now: new Date(frame.request.now),
        signal,
        timeoutMs,
      }), signal);
      response = runnerControlResponseFrame(frame.correlationId, {
        status: "ok",
        data: {
          message: result.message,
          ...(result.data !== undefined ? { data: result.data } : {}),
        },
      });
    } catch (error) {
      if (signal.aborted) {
        fallbackLifetime?.cleanup();
        continue;
      }
      response = runnerControlResponseFrame(frame.correlationId, {
        status: "error",
        error: {
          code: "schedule_handler_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      fallbackLifetime?.cleanup();
    }
    const delivered = await deps.runnerCommandDispatcher.sendControlFrame(response);
    if (!delivered) {
      throw new Error(`Runner rejected control response: ${frame.correlationId}`);
    }
  }
  // Drain and publish first; preserve richer dispatcher exceptions when present.
  if (fatalError) throw fatalError;
}

function createTimeoutLifetime(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Runner request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const rejectOnAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", rejectOnAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", rejectOnAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason ? String(signal.reason) : "Runner request aborted");
}
