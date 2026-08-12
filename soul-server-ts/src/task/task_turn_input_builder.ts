import type { Logger } from "pino";

import type { AgentProfile } from "../agent_registry.js";
import {
  composeFirstTurnPrompt,
  type ExecutionContextBuilder,
  type FollowupContext,
  type PreparedContext,
} from "../context/context_builder.js";
import { formatContextItems } from "../context/prompt_assembler.js";

import { splitAttachmentPaths } from "./attachment_context.js";
import { buildDeliveryInputUuid } from "./delivery_identity.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";
import { effectiveTaskBackend } from "./task_model_preset.js";
import { isSessionDataHostError } from "../control_plane/session_data_host_client.js";

export interface TaskTurnInput {
  prompt: string;
  imageAttachmentPaths: string[];
  systemPrompt?: string;
  inputUuid?: string;
  runnerInterventionId?: string;
  intervention?: InterventionMessage;
  backendSessionRolloverFrom?: string;
}

export interface TaskTurnInputBuilderDeps {
  contextBuilder?: ExecutionContextBuilder;
  initialMessagePublisher: TaskInitialMessagePublisherPort;
  logger: Logger;
}

export interface TaskInitialMessagePublisherPort {
  publishInitialMessages(task: Task, ctx?: PreparedContext): Promise<void>;
}

export class TaskTurnInputBuilder {
  constructor(private readonly deps: TaskTurnInputBuilderDeps) {}

  async prepareInitialTurnInput(task: Task, agent: AgentProfile): Promise<TaskTurnInput> {
    if (task.interventionQueue.length > 0) {
      const intervention = task.interventionQueue.shift()!;
      return this.prepareFollowupTurnInput(task, agent, intervention);
    }

    const ctx = await this.buildContext(task, agent);
    await this.deps.initialMessagePublisher.publishInitialMessages(task, ctx);
    this.recordInitialContextInjection(task);

    return this.prepareNewTaskTurnInput(task, agent, ctx);
  }

  async prepareFollowupTurnInput(
    task: Task,
    agent: AgentProfile,
    intervention: InterventionMessage,
  ): Promise<TaskTurnInput> {
    const currentCallerInfo = intervention.callerInfo ?? task.callerInfo;
    const includeFullContext = task.needsFullContextReinjection === true;
    const includeClaudeSessionIdUpdate =
      Boolean(task.codexThreadId) &&
      task.lastInjectedClaudeSessionId !== task.codexThreadId;
    const ctx = await this.buildFollowupContext(task, agent, {
      includeFullContext,
      includeClaudeSessionIdUpdate,
      previousCallerInfo: task.lastInjectedCallerInfo,
      currentCallerInfo,
    });
    if (includeFullContext) {
      task.needsFullContextReinjection = false;
    }

    if (ctx) {
      this.recordFollowupContextInjection(task, currentCallerInfo);
    }

    const composed = composeInterventionTurnPrompt(intervention);
    const prompt = appendContextBlock(composed.prompt, ctx?.contextItems ?? []);
    const systemPrompt =
      effectiveTaskBackend(task, agent) === "claude" && includeFullContext
        ? ctx?.effectiveSystemPrompt
        : undefined;
    return {
      prompt,
      imageAttachmentPaths: composed.imageAttachmentPaths,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(intervention.deliveryId
        ? { inputUuid: buildDeliveryInputUuid(intervention.deliveryId) }
        : {}),
      ...(intervention.runnerInterventionId
        ? { runnerInterventionId: intervention.runnerInterventionId }
        : {}),
      intervention,
    };
  }

  async prepareBackendRolloverTurnInput(
    task: Task,
    agent: AgentProfile,
    failedInput: TaskTurnInput,
    backendSessionRolloverFrom: string,
  ): Promise<TaskTurnInput> {
    const currentCallerInfo = failedInput.intervention?.callerInfo ?? task.callerInfo;
    const ctx = await this.buildFollowupContext(task, agent, {
      includeFullContext: true,
      includeClaudeSessionIdUpdate: false,
      previousCallerInfo: task.lastInjectedCallerInfo,
      currentCallerInfo,
    });
    task.needsFullContextReinjection = false;
    if (ctx) this.recordFollowupContextInjection(task, currentCallerInfo);

    const replayBase = failedInput.intervention
      ? composeInterventionTurnPrompt(failedInput.intervention)
      : {
          prompt: failedInput.prompt,
          imageAttachmentPaths: failedInput.imageAttachmentPaths,
        };
    return {
      prompt: appendContextBlock(replayBase.prompt, ctx?.contextItems ?? []),
      imageAttachmentPaths: replayBase.imageAttachmentPaths,
      ...(ctx?.effectiveSystemPrompt !== undefined
        ? { systemPrompt: ctx.effectiveSystemPrompt }
        : {}),
      ...(failedInput.inputUuid !== undefined ? { inputUuid: failedInput.inputUuid } : {}),
      ...(failedInput.intervention !== undefined
        ? { intervention: failedInput.intervention }
        : {}),
      backendSessionRolloverFrom,
    };
  }

  private async buildContext(
    task: Task,
    agent: AgentProfile,
  ): Promise<PreparedContext | undefined> {
    if (!this.deps.contextBuilder) {
      return undefined;
    }

    try {
      return await this.deps.contextBuilder.build(task, agent);
    } catch (err) {
      if (isSessionDataHostError(err)) throw err;
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "context_builder failed — falling back to task.prompt without context",
      );
      return undefined;
    }
  }

  private prepareNewTaskTurnInput(
    task: Task,
    agent: AgentProfile,
    ctx: PreparedContext | undefined,
  ): TaskTurnInput {
    const imageAttachmentPaths = splitAttachmentPaths(task.attachmentPaths).imagePaths;
    if (!ctx) {
      return {
        prompt: task.prompt,
        imageAttachmentPaths,
      };
    }

    if (effectiveTaskBackend(task, agent) === "claude") {
      return {
        prompt: composeFirstTurnPrompt({
          effectiveSystemPrompt: undefined,
          combinedContextItems: ctx.combinedContextItems,
          assembledPrompt: task.prompt,
        }),
        imageAttachmentPaths,
        ...(ctx.effectiveSystemPrompt !== undefined
          ? { systemPrompt: ctx.effectiveSystemPrompt }
          : {}),
      };
    }

    return {
      prompt: composeFirstTurnPrompt({
        ...ctx,
        assembledPrompt: task.prompt,
      }),
      imageAttachmentPaths,
    };
  }

  private async buildFollowupContext(
    task: Task,
    agent: AgentProfile,
    options: Parameters<ExecutionContextBuilder["buildFollowupContext"]>[2],
  ): Promise<FollowupContext | undefined> {
    if (!this.deps.contextBuilder) {
      return undefined;
    }

    try {
      return await this.deps.contextBuilder.buildFollowupContext(
        task,
        agent,
        options,
      );
    } catch (err) {
      if (isSessionDataHostError(err)) throw err;
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "follow-up context_builder failed — continuing without dynamic context",
      );
      return undefined;
    }
  }

  private recordInitialContextInjection(task: Task): void {
    if (task.codexThreadId) {
      task.lastInjectedClaudeSessionId = task.codexThreadId;
    }
    if (task.callerInfo) {
      task.lastInjectedCallerInfo = task.callerInfo;
    }
  }

  private recordFollowupContextInjection(
    task: Task,
    currentCallerInfo: Task["callerInfo"],
  ): void {
    if (task.codexThreadId) {
      task.lastInjectedClaudeSessionId = task.codexThreadId;
    }
    if (currentCallerInfo) {
      task.lastInjectedCallerInfo = currentCallerInfo;
    }
  }
}

function appendContextBlock(prompt: string, contextItems: FollowupContext["contextItems"]): string {
  const contextBlock = formatContextItems(contextItems);
  if (!contextBlock) return prompt;
  return `${prompt}\n\n${contextBlock}`;
}
