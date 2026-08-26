import type { AgentProfile } from "../agent_registry.js";
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
import { sseEventFromRunnerFrame } from "../runner/engine_event_stream.js";
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

import type { Task } from "./task_models.js";

export interface TaskEngineTurnInput {
  prompt: string;
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
export class TaskEngineTurnRunner {
  constructor(private readonly deps: TaskEngineTurnRunnerDeps) {}

  executeTurn({
    task,
    agent,
    runner,
    input,
  }: TaskEngineTurnRunnerParams): AsyncIterable<SSEEventPayload> {
    const { engine, dispatcher } = runner;
    const queuedToolApproval = task.agentsQueuedToolApproval;
    task.agentsQueuedToolApproval = undefined;

    const effectiveAllowedTools = task.allowedTools ?? agent.allowed_tools;
    const effectiveDisallowedTools = task.disallowedTools ?? agent.disallowed_tools;
    const effectiveClaudePermissionMode = task.claudePermissionMode ?? agent.claude_permission_mode;
    const effectiveModel = task.model ?? agent.model;
    const hasResolvedPreset = task.modelPresetBackend !== undefined;
    const extraEnv = engine.backendId === "claude"
      ? buildClaudeExtraEnv({
          profileEnv: hasResolvedPreset ? (task.modelPresetEnv ?? {}) : agent.env,
          oauthToken: task.oauthToken,
          sourceLabel: hasResolvedPreset ? "model preset" : "agents.yaml",
        })
      : undefined;

    const executeParams: EngineExecuteParams = {
      agentSessionId: task.agentSessionId,
      ...(task.executionOwnership
        ? { executionGeneration: task.executionOwnership.ownershipGeneration }
        : {}),
      prompt: input.prompt,
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
      ...(task.reasoningEffort !== undefined ? { reasoningEffort: task.reasoningEffort } : {}),
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
      ...(effectiveClaudePermissionMode !== undefined
        ? { claudePermissionMode: effectiveClaudePermissionMode }
        : {}),
      ...(agent.max_turns !== undefined ? { maxTurns: agent.max_turns } : {}),
      ...(extraEnv !== undefined ? { extraEnv } : {}),
      ...(this.deps.scheduleToolHandler !== undefined
        ? { scheduleToolUseEnabled: true }
        : {}),
    };
    const frames = dispatcher.executeFrames(executeParams);

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
  for await (const frame of frames) {
    if (frame.kind === "engine_event") {
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
