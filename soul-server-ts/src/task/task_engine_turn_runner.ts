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

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";

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

type ProcessEnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

function resolveProfileEnvValue(
  envKey: string,
  rawValue: string,
  processEnv: ProcessEnvLike,
): string {
  if (rawValue.startsWith("${") && rawValue.endsWith("}")) {
    const sourceKey = rawValue.slice(2, -1);
    if (sourceKey.length === 0) {
      throw new Error(`agents.yaml env '${envKey}' has an empty variable reference`);
    }
    const resolved = processEnv[sourceKey];
    if (resolved === undefined || resolved === "") {
      throw new Error(
        `agents.yaml env '${envKey}' references missing environment variable '${sourceKey}'`,
      );
    }
    return resolved;
  }
  return rawValue;
}

function validateProfileEnvAuthBundle(env: Record<string, string>): void {
  const hasApiKey = ANTHROPIC_API_KEY_ENV in env;
  const hasBaseUrl = ANTHROPIC_BASE_URL_ENV in env;
  if (hasApiKey !== hasBaseUrl) {
    throw new Error(
      "agents.yaml env must set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL together",
    );
  }
  if (hasApiKey && CLAUDE_OAUTH_TOKEN_ENV in env) {
    throw new Error(
      "agents.yaml env cannot mix ANTHROPIC_API_KEY with CLAUDE_CODE_OAUTH_TOKEN",
    );
  }
}

function resolveProfileEnv(
  rawEnv: Record<string, string> | undefined,
  processEnv: ProcessEnvLike,
): Record<string, string> | undefined {
  if (rawEnv === undefined || Object.keys(rawEnv).length === 0) {
    return undefined;
  }
  const env = Object.fromEntries(
    Object.entries(rawEnv).map(([key, value]) => [
      key,
      resolveProfileEnvValue(key, value, processEnv),
    ]),
  );
  validateProfileEnvAuthBundle(env);
  return env;
}

function buildClaudeExtraEnv(params: {
  profileEnv?: Record<string, string>;
  oauthToken?: string;
  processEnv?: ProcessEnvLike;
}): Record<string, string> | undefined {
  const extraEnv: Record<string, string> = {
    ...(resolveProfileEnv(params.profileEnv, params.processEnv ?? process.env) ?? {}),
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
    const extraEnv = engine.backendId === "claude"
      ? buildClaudeExtraEnv({ profileEnv: agent.env, oauthToken: task.oauthToken })
      : undefined;

    return engine.execute({
      agentSessionId: task.agentSessionId,
      prompt: input.prompt,
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
    });
  }
}
