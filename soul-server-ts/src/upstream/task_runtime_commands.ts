import type { Logger } from "pino";

import type { AgentProfile, AgentRegistry } from "../agent_registry.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { BoardYjsContainerRef } from "../db/session_db.js";
import type {
  ClaudePermissionMode,
  EngineInterventionFailureReason,
  ReasoningEffort,
} from "../engine/protocol.js";
import { appendAttachmentPathNotes } from "../task/attachment_path_note.js";
import type {
  AddInterventionResult,
  TaskManager,
} from "../task/task_manager.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { CallerInfo, SessionCreationWarning, Task } from "../task/task_models.js";
import type { DeliveryIntent } from "../task/delivery_contract.js";
import { resolveModelPresetSelection } from "../task/task_model_preset.js";
import type { NewSessionAgentProfileSource } from "../agent_profile_source.js";

interface TaskRuntimeCommandsDeps {
  agentRegistry: Pick<AgentRegistry, "get">;
  taskManager: Pick<TaskManager, "createTask" | "addIntervention">;
  taskExecutor: Pick<TaskExecutor, "startExecution">;
  logger: Logger;
  modelCatalog?: Pick<ModelCatalog, "resolve">;
  agentProfileSource?: NewSessionAgentProfileSource;
}

export interface CreateSessionRuntimeParams {
  agentSessionId: string;
  prompt: string;
  profileId: string;
  callerSessionId?: string | null;
  predecessorSessionId?: string | null;
  callerInfo?: CallerInfo;
  notifyCompletion?: boolean;
  attachmentPaths?: string[];
  extraContextItems?: ContextItem[];
  model?: string | null;
  modelPreset?: string | null;
  oauthToken?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  useMcp?: boolean;
  claudePermissionMode?: ClaudePermissionMode;
  reasoningEffort?: ReasoningEffort;
  folderId?: string | null;
  container?: BoardYjsContainerRef | null;
  sourceTaskItemId?: string | null;
  systemPrompt?: string;
  pageAnchor?: { pageId: string; blockId: string; expectedVersion: number };
}

export interface InterveneRuntimeParams {
  agentSessionId: string;
  text: string;
  user?: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
  extraContextItems?: ContextItem[];
  deliveryId?: string;
  deliveryIntent?: DeliveryIntent;
  source?: string;
  completionId?: string;
  relationKey?: string;
  producerTerminalRevision?: string;
  parentDeliveryId?: string;
  callerTurnId?: string;
  deliveryCreatedAt?: string;
  deliveryLeaseOwner?: string;
}

export interface SessionCreatedAck {
  type: "session_created";
  requestId: string;
  agentSessionId: string;
  warnings?: SessionCreationWarning[];
}

export type InterveneAck =
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "unknown";
      agentSessionId: string;
      delivered: null;
      consumeWhen: null;
      reason: "verdict_unknown";
    }
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "delivered";
      agentSessionId: string;
      delivered: true;
    }
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "queued";
      agentSessionId: string;
      delivered: false;
      queuePosition: number;
      consumeWhen: "next_turn";
      reason: EngineInterventionFailureReason | "queue_only_policy";
    }
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "auto_resumed";
      agentSessionId: string;
      delivered: true;
    }
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "deferred";
      agentSessionId: string;
      delivered: false;
      retryWhen: "engine_available" | "terminal_state";
      reason: EngineInterventionFailureReason | "terminal_only_policy";
    }
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "suppressed";
      agentSessionId: string;
      deliveryId: string;
      delivered: false;
      reason: string;
    };

export class UnknownAgentProfileError extends Error {
  constructor(profileId: string) {
    super(`Unknown agent profile: ${profileId}`);
    this.name = "UnknownAgentProfileError";
  }
}

/**
 * Owns the upstream command -> task runtime boundary.
 *
 * TaskCreation owns new task persistence and session_created broadcast ordering.
 * TaskInterventionRoute owns intervention route selection. This boundary owns
 * the upstream-specific adaptation between those public task APIs and execution:
 * agent profile resolution, attachment context assembly, per-backend OAuth
 * forwarding, and startExecution callback wiring.
 */
export class TaskRuntimeCommands {
  constructor(private readonly deps: TaskRuntimeCommandsDeps) {}

  async createSession(params: CreateSessionRuntimeParams): Promise<Task> {
    const resolvedAgent = await this.resolveNewSessionAgent(params.profileId);
    const agent = resolvedAgent.profile;
    const preset = resolveModelPresetSelection(
      params,
      agent,
      this.deps.modelCatalog,
    );
    const prompt = appendAttachmentPathNotes(params.prompt, params.attachmentPaths);
    const task = await this.deps.taskManager.createTask({
      agentSessionId: params.agentSessionId,
      prompt,
      profileId: agent.id,
      ...(resolvedAgent.fromSource
        ? {
            agentProfileSnapshot: agent,
            agentProfileHasDbPortrait: resolvedAgent.hasDbPortrait,
          }
        : {}),
      callerSessionId: params.callerSessionId ?? null,
      predecessorSessionId: params.predecessorSessionId ?? null,
      callerInfo: params.callerInfo,
      notifyCompletion: params.notifyCompletion,
      model: preset?.model ?? params.model,
      ...(preset
        ? {
            modelPreset: preset.id,
            modelPresetBackend: preset.backend,
            modelPresetEnv: preset.env,
          }
        : {}),
      oauthToken:
        (preset?.backend ?? agent.backend) === "claude"
          ? normalizeOptionalString(params.oauthToken)
          : undefined,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      useMcp: params.useMcp,
      claudePermissionMode: params.claudePermissionMode,
      folderId: params.folderId ?? null,
      container: params.container ?? null,
      sourceTaskItemId: params.sourceTaskItemId ?? null,
      systemPrompt: params.systemPrompt,
      contextItems: params.extraContextItems,
      attachmentPaths: params.attachmentPaths,
      pageAnchor: params.pageAnchor,
    });

    this.deps.taskExecutor.startExecution(task, agent);
    return task;
  }

  async intervene(params: InterveneRuntimeParams): Promise<AddInterventionResult> {
    return await this.deps.taskManager.addIntervention(
      {
        agentSessionId: params.agentSessionId,
        text: appendAttachmentPathNotes(params.text, params.attachmentPaths),
        user: params.user ?? "upstream",
        callerInfo: params.callerInfo,
        attachmentPaths: params.attachmentPaths,
        context: params.extraContextItems,
        deliveryId: params.deliveryId,
        deliveryIntent: params.deliveryIntent,
        source: params.source,
        completionId: params.completionId,
        relationKey: params.relationKey,
        producerTerminalRevision: params.producerTerminalRevision,
        parentDeliveryId: params.parentDeliveryId,
        callerTurnId: params.callerTurnId,
        deliveryCreatedAt: params.deliveryCreatedAt,
        deliveryLeaseOwner: params.deliveryLeaseOwner,
      },
      (task) => this.startResumedTask(task),
    );
  }

  private requireAgent(profileId: string): AgentProfile {
    const agent = this.deps.agentRegistry.get(profileId);
    if (!agent) {
      throw new UnknownAgentProfileError(profileId);
    }
    return agent;
  }

  private async resolveNewSessionAgent(profileId: string): Promise<{
    profile: AgentProfile;
    hasDbPortrait: boolean;
    fromSource: boolean;
  }> {
    if (!this.deps.agentProfileSource) {
      const profile = this.requireAgent(profileId);
      return { profile, hasDbPortrait: false, fromSource: false };
    }
    const resolved = await this.deps.agentProfileSource.resolve(profileId);
    if (!resolved) throw new UnknownAgentProfileError(profileId);
    return {
      profile: resolved.profile,
      hasDbPortrait: resolved.portraitSource === "db",
      fromSource: true,
    };
  }

  private startResumedTask(task: Task): void {
    if (!task.profileId) {
      throw new Error(
        `Cannot auto-resume ${task.agentSessionId}: task is missing profileId`,
      );
    }
    const agent = task.agentProfileSnapshot ?? this.requireAgent(task.profileId);
    this.deps.taskExecutor.startExecution(task, agent);
  }
}

export function buildSessionCreatedAck(params: {
  requestId: string;
  agentSessionId: string;
  warnings?: SessionCreationWarning[];
}): SessionCreatedAck {
  return {
    type: "session_created",
    agentSessionId: params.agentSessionId,
    requestId: params.requestId,
    ...(params.warnings?.length ? { warnings: params.warnings } : {}),
  };
}

export function buildInterveneAck(params: {
  requestId: string;
  agentSessionId: string;
  result: AddInterventionResult;
}): InterveneAck {
  const { requestId, agentSessionId, result } = params;
  if ("queued" in result) {
    return {
      type: "intervene_ack",
      requestId,
      status: "ok",
      outcome: "queued",
      agentSessionId,
      delivered: false,
      queuePosition: result.queuePosition,
      consumeWhen: result.consumeWhen,
      reason: result.reason,
    };
  }
  if ("delivered" in result && result.delivered === null) {
    return {
      type: "intervene_ack",
      requestId,
      status: "ok",
      outcome: "unknown",
      agentSessionId,
      delivered: null,
      consumeWhen: null,
      reason: result.reason,
    };
  }
  if ("deferred" in result) {
    return {
      type: "intervene_ack",
      requestId,
      status: "ok",
      outcome: "deferred",
      agentSessionId,
      delivered: false,
      retryWhen: result.retryWhen,
      reason: result.reason,
    };
  }
  if ("delivered" in result && result.delivered === true) {
    return {
      type: "intervene_ack",
      requestId,
      status: "ok",
      outcome: "delivered",
      agentSessionId,
      delivered: true,
    };
  }
  if ("suppressed" in result) {
    return {
      type: "intervene_ack",
      requestId,
      status: "ok",
      outcome: "suppressed",
      agentSessionId,
      deliveryId: result.deliveryId,
      delivered: false,
      reason: result.reason,
    };
  }
  if ("autoResumed" in result) {
    return {
      type: "intervene_ack",
      requestId,
      status: "ok",
      outcome: "auto_resumed",
      agentSessionId,
      delivered: true,
    };
  }
  const exhaustive: never = result;
  throw new Error(`Unknown intervention result: ${JSON.stringify(exhaustive)}`);
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
