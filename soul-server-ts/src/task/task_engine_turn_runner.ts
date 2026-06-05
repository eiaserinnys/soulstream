import type { AgentProfile } from "../agent_registry.js";
import type {
  EnginePort,
  EngineRunStateSnapshot,
  EngineSessionItemsSnapshot,
  ScheduleToolUseHandler,
  SSEEventPayload,
} from "../engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../engine/claude_options.js";

import type { Task } from "./task_models.js";

export interface TaskEngineTurnInput {
  prompt: string;
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
    const extraEnv = task.oauthToken && engine.backendId === "claude"
      ? { [CLAUDE_OAUTH_TOKEN_ENV]: task.oauthToken }
      : undefined;

    return engine.execute({
      agentSessionId: task.agentSessionId,
      prompt: input.prompt,
      imageAttachmentPaths: input.imageAttachmentPaths,
      model: task.model,
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
    });
  }
}
