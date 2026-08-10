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
  engineEventFrame,
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
      onRunStateSnapshot: (snapshot) =>
        this.deps.snapshotPersistence.persistRunStateSnapshot(task, snapshot),
      onSessionItemsSnapshot: (snapshot) =>
        this.deps.snapshotPersistence.persistSessionItemsSnapshot(task, snapshot),
      // Do not pass the legacy polling hook. Running interventions use the engine
      // live-steering capability; unsupported/idle-race cases remain queued.
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
        ? { onScheduleToolUse: this.deps.scheduleToolHandler }
        : {}),
    };
    const frames = engine.executeFrames
      ? engine.executeFrames(executeParams)
      : legacyEngineEventFrames(engine.execute(executeParams));

    return consumeRunnerFrames(frames, task, this.deps.snapshotPersistence);
  }
}

async function* consumeRunnerFrames(
  frames: AsyncIterable<RunnerEventFrame>,
  task: Task,
  snapshotPersistence: TaskAgentsSnapshotPersistencePort,
): AsyncIterable<SSEEventPayload> {
  for await (const frame of frames) {
    if (frame.kind === "engine_event") {
      yield sseEventFromRunnerFrame(frame);
      continue;
    }
    if (frame.kind === "run_state_snapshot") {
      await snapshotPersistence.persistRunStateSnapshot(task, frame.snapshot);
      continue;
    }
    if (frame.kind === "session_items_snapshot") {
      await snapshotPersistence.persistSessionItemsSnapshot(task, frame.snapshot);
      continue;
    }
    throw new Error(`Unhandled runner request frame: ${frame.request.kind}`);
  }
}

async function* legacyEngineEventFrames(
  events: AsyncIterable<SSEEventPayload>,
): AsyncIterable<RunnerEventFrame> {
  for await (const event of events) {
    yield engineEventFrame(event as Record<string, unknown>);
  }
}
