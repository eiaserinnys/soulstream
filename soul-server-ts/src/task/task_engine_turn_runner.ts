import type { AgentProfile } from "../agent_registry.js";
import type {
  EngineExecuteParams,
  EnginePort,
  EngineRunStateSnapshot,
  EngineSessionItemsSnapshot,
  ScheduleToolUseHandler,
  SSEEventPayload,
} from "../engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../engine/claude_options.js";
import { sseEventFromRunnerFrame } from "../runner/engine_event_stream.js";
import {
  DEFAULT_RUNNER_REQUEST_TIMEOUT_MS,
  InProcessRunnerFrameChannel,
} from "../runner/in_process_frame_channel.js";
import {
  engineEventFrame,
  runnerControlResponseFrame,
  type RunnerEventFrame,
} from "../runner/frame_protocol.js";
import {
  ANTHROPIC_API_KEY_ENV,
  resolveModelPresetEnv,
} from "../model_preset_env.js";

import type { Task } from "./task_models.js";

export interface TaskEngineTurnInput {
  prompt: string;
  inputUuid?: string;
  imageAttachmentPaths?: string[];
  systemPrompt?: string;
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
  engine: EnginePort;
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
    engine,
    input,
  }: TaskEngineTurnRunnerParams): AsyncIterable<SSEEventPayload> {
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
      prompt: input.prompt,
      ...(input.inputUuid ? { inputUuid: input.inputUuid } : {}),
      imageAttachmentPaths: input.imageAttachmentPaths,
      model: effectiveModel,
      reasoningEffort: task.reasoningEffort,
      resumeSessionId: task.codexThreadId,
      resumeRunState: task.agentsRunState,
      previousResponseId: task.agentsPreviousResponseId,
      conversationId: task.agentsConversationId,
      sessionItems: task.agentsSessionItems,
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
    const frames = engine.executeFrames
      ? engine.executeFrames(executeParams)
      : legacyEngineEventFrames(engine.execute(executeParams));

    return consumeRunnerFrames(frames, {
      task,
      engine,
      snapshotPersistence: this.deps.snapshotPersistence,
      scheduleToolHandler: this.deps.scheduleToolHandler,
    });
  }
}

async function* consumeRunnerFrames(
  frames: AsyncIterable<RunnerEventFrame>,
  deps: {
    task: Task;
    engine: EnginePort;
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
    if (frame.request.kind !== "schedule_tool_use") {
      throw new Error(`Unhandled runner request frame: ${frame.request.kind}`);
    }
    if (!deps.scheduleToolHandler || !deps.engine.sendControlFrame) {
      throw new Error("Runner emitted schedule request without a host control boundary");
    }
    const timeoutMs = frame.timeoutMs ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS;
    const channelContext = frames instanceof InProcessRunnerFrameChannel
      ? frames.requestContext(frame.correlationId)
      : undefined;
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
    const delivered = await deps.engine.sendControlFrame(response);
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

async function* legacyEngineEventFrames(
  events: AsyncIterable<SSEEventPayload>,
): AsyncIterable<RunnerEventFrame> {
  for await (const event of events) {
    yield engineEventFrame(event as Record<string, unknown>);
  }
}
