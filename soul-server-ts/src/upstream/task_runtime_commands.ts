import type { Logger } from "pino";

import type { AgentProfile, AgentRegistry } from "../agent_registry.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { ClaudePermissionMode, ReasoningEffort } from "../engine/protocol.js";
import { appendAttachmentPathNotes } from "../task/attachment_path_note.js";
import type {
  AddInterventionResult,
  TaskManager,
} from "../task/task_manager.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { CallerInfo, Task } from "../task/task_models.js";

interface TaskRuntimeCommandsDeps {
  agentRegistry: Pick<AgentRegistry, "get">;
  taskManager: Pick<TaskManager, "createTask" | "addIntervention">;
  taskExecutor: Pick<TaskExecutor, "startExecution">;
  logger: Logger;
}

export interface CreateSessionRuntimeParams {
  agentSessionId: string;
  prompt: string;
  profileId: string;
  callerSessionId?: string | null;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
  extraContextItems?: ContextItem[];
  model?: string | null;
  oauthToken?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  useMcp?: boolean;
  claudePermissionMode?: ClaudePermissionMode;
  reasoningEffort?: ReasoningEffort;
  folderId?: string | null;
  systemPrompt?: string;
}

export interface InterveneRuntimeParams {
  agentSessionId: string;
  text: string;
  user?: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
}

export interface SessionCreatedAck {
  type: "session_created";
  requestId: string;
  agentSessionId: string;
}

export type InterveneAck =
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "delivered";
      agentSessionId: string;
    }
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "queued";
      queuePosition: number;
    }
  | {
      type: "intervene_ack";
      requestId: string;
      status: "ok";
      outcome: "auto_resumed";
      agentSessionId: string;
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
    const agent = this.requireAgent(params.profileId);
    const prompt = appendAttachmentPathNotes(params.prompt, params.attachmentPaths);
    const task = await this.deps.taskManager.createTask({
      agentSessionId: params.agentSessionId,
      prompt,
      profileId: params.profileId,
      callerSessionId: params.callerSessionId ?? null,
      callerInfo: params.callerInfo,
      model: params.model,
      oauthToken:
        agent.backend === "claude"
          ? normalizeOptionalString(params.oauthToken)
          : undefined,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      useMcp: params.useMcp,
      claudePermissionMode: params.claudePermissionMode,
      folderId: params.folderId ?? null,
      systemPrompt: params.systemPrompt,
      contextItems: params.extraContextItems,
      attachmentPaths: params.attachmentPaths,
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

  private startResumedTask(task: Task): void {
    if (!task.profileId) {
      this.deps.logger.error(
        { sessionId: task.agentSessionId },
        "intervene auto-resume aborted — task missing profileId",
      );
      return;
    }
    const agent = this.deps.agentRegistry.get(task.profileId);
    if (!agent) {
      this.deps.logger.error(
        { sessionId: task.agentSessionId, profileId: task.profileId },
        "intervene auto-resume aborted — agent profile not found",
      );
      return;
    }
    this.deps.taskExecutor.startExecution(task, agent);
  }
}

export function buildSessionCreatedAck(params: {
  requestId: string;
  agentSessionId: string;
}): SessionCreatedAck {
  return {
    type: "session_created",
    agentSessionId: params.agentSessionId,
    requestId: params.requestId,
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
      queuePosition: result.queuePosition,
    };
  }
  if ("delivered" in result) {
    return {
      type: "intervene_ack",
      requestId,
      status: "ok",
      outcome: "delivered",
      agentSessionId,
    };
  }
  return {
    type: "intervene_ack",
    requestId,
    status: "ok",
    outcome: "auto_resumed",
    agentSessionId,
  };
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
