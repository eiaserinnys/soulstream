import type { Logger } from "pino";

import type { AgentProfile, AgentRegistry } from "../agent_registry.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { ContextItem } from "../context/prompt_assembler.js";
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
import type { PurposeDecisionCommand, PurposeDecisionRunner } from "../card-orchestration/purpose_runner.js";

export interface OrchestrationWorkerAdmission {
  cardId: string; runId: string; executionToken: string;
}
export type AuthorizeOrchestrationWorker = (request: OrchestrationWorkerAdmission & { sessionId: string }) => Promise<boolean>;

interface TaskRuntimeCommandsDeps {
  agentRegistry: Pick<AgentRegistry, "get">;
  taskManager: Pick<TaskManager, "createTask" | "addIntervention"> & Partial<Pick<TaskManager, "ensureRunning">>;
  taskExecutor: Pick<TaskExecutor, "startNewExecution">;
  logger: Logger;
  modelCatalog?: Pick<ModelCatalog, "resolve">;
  agentProfileSource?: NewSessionAgentProfileSource;
  decisionRunner?: Pick<PurposeDecisionRunner, "create" | "cancel" | "prepare">;
  authorizeOrchestrationWorker?: AuthorizeOrchestrationWorker;
}

export interface CreateSessionRuntimeParams {
  orchestrationAdmission?: OrchestrationWorkerAdmission;
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
  cardId?: string | null;
  worktreeId?: string;
  worktreeActorSessionId?: string;
  systemPrompt?: string;
  pageAnchor?: { pageId: string; blockId: string; expectedVersion: number };
}

export interface InterveneRuntimeParams {
  orchestrationAdmission?: OrchestrationWorkerAdmission;
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
  deliveryAttemptToken?: string;
  rateLimitType?: string;
  resetsAt?: string;
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
      reason: EngineInterventionFailureReason | "queue_only_policy" | "verdict_unknown";
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
      reason: EngineInterventionFailureReason | "terminal_only_policy" | "verdict_unknown";
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
 * forwarding, and startNewExecution callback wiring.
 */
export class TaskRuntimeCommands {
  constructor(private readonly deps: TaskRuntimeCommandsDeps) {}

  createDecisionSession(params: PurposeDecisionCommand): Promise<Task> {
    if (!this.deps.decisionRunner) throw new Error("Dedicated decision runtime unavailable");
    return this.deps.decisionRunner.create(params);
  }

  prepareDecisionSession(params: Pick<PurposeDecisionCommand, "profileId" | "modelPreset">) {
    if (!this.deps.decisionRunner) return Promise.resolve({ status: "unavailable" as const, reason: "decision_runtime_unavailable" });
    return this.deps.decisionRunner.prepare(params);
  }

  cancelDecisionSession(sessionId: string): boolean {
    return this.deps.decisionRunner?.cancel(sessionId) ?? false;
  }

  async createSession(params: CreateSessionRuntimeParams): Promise<Task> {
    const resolvedAgent = await this.resolveNewSessionAgent(params.profileId);
    const agent = resolvedAgent.profile;
    const preset = resolveModelPresetSelection(
      params,
      agent,
      this.deps.modelCatalog,
    );
    const prompt = appendAttachmentPathNotes(params.prompt, params.attachmentPaths);
    await this.authorizeWorker(params.agentSessionId, params.orchestrationAdmission, params.cardId ?? null);
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
      cardId: params.cardId ?? null,
      worktreeId: params.worktreeId,
      worktreeActorSessionId: params.worktreeActorSessionId,
      systemPrompt: params.systemPrompt,
      contextItems: params.extraContextItems,
      attachmentPaths: params.attachmentPaths,
      pageAnchor: params.pageAnchor,
    });

    this.deps.taskExecutor.startNewExecution(task, agent);
    return task;
  }

  async intervene(params: InterveneRuntimeParams): Promise<AddInterventionResult> {
    await this.authorizeWorker(params.agentSessionId, params.orchestrationAdmission);
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
        deliveryAttemptToken: params.deliveryAttemptToken,
        rateLimitType: params.rateLimitType,
        resetsAt: params.resetsAt,
      },
      (task, activation) => this.startResumedTask(task, activation),
    );
  }

  async ensureSessionRunning(params: InterveneRuntimeParams) {
    if (!params.deliveryId) throw new Error("ensure_session_running requires deliveryId");
    if (!this.deps.taskManager.ensureRunning) throw new Error("ensure running is unavailable");
    return this.deps.taskManager.ensureRunning({
      agentSessionId: params.agentSessionId, text: params.text,
      user: params.user ?? "upstream", callerInfo:params.callerInfo,
      attachmentPaths:params.attachmentPaths,deliveryId:params.deliveryId,
      deliveryIntent:"durable_next_turn",source:"card_execution",
      completionId:params.deliveryId,relationKey:params.deliveryId,
    }, (task,activation)=>this.startResumedTask(task,activation));
  }

  private async authorizeWorker(sessionId: string, marker?: OrchestrationWorkerAdmission, cardId?: string | null): Promise<void> {
    if (marker === undefined) return;
    if (!marker || typeof marker.runId !== "string" || !marker.runId
      || typeof marker.executionToken !== "string" || !marker.executionToken
      || typeof marker.cardId !== "string" || !marker.cardId
      || (cardId !== undefined && marker.cardId !== cardId)
      || !this.deps.authorizeOrchestrationWorker
      || !await this.deps.authorizeOrchestrationWorker({ sessionId, cardId: marker.cardId,
        runId: marker.runId, executionToken: marker.executionToken })) {
      throw new Error("Worker admission denied");
    }
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

  private startResumedTask(
    task: Task,
    activation?: Task["executionActivation"],
  ): void {
    if (!task.profileId) {
      throw new Error(
        `Cannot auto-resume ${task.agentSessionId}: task is missing profileId`,
      );
    }
    const agent = task.agentProfileSnapshot ?? this.requireAgent(task.profileId);
    if (activation) this.deps.taskExecutor.startNewExecution(task, agent, activation);
    else this.deps.taskExecutor.startNewExecution(task, agent);
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
