import type { Logger } from "pino";

import type { AgentProfile } from "../agent_registry.js";
import {
  composeFirstTurnPrompt,
  type ExecutionContextBuilder,
  type PreparedContext,
} from "../context/context_builder.js";

import { splitAttachmentPaths } from "./attachment_context.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";

export interface TaskTurnInput {
  prompt: string;
  imageAttachmentPaths: string[];
  systemPrompt?: string;
  intervention?: InterventionMessage;
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
    const ctx = await this.buildContext(task, agent);
    await this.deps.initialMessagePublisher.publishInitialMessages(task, ctx);

    if (task.interventionQueue.length > 0) {
      return this.prepareQueuedInterventionTurnInput(task, agent, ctx);
    }

    return this.prepareNewTaskTurnInput(task, agent, ctx);
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

    if (agent.backend === "claude") {
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

  private async prepareQueuedInterventionTurnInput(
    task: Task,
    agent: AgentProfile,
    ctx: PreparedContext | undefined,
  ): Promise<TaskTurnInput> {
    const intervention = task.interventionQueue.shift()!;
    const composed = composeInterventionTurnPrompt(intervention);
    const systemPrompt =
      agent.backend === "claude" ? ctx?.effectiveSystemPrompt : undefined;
    return {
      prompt: composed.prompt,
      imageAttachmentPaths: composed.imageAttachmentPaths,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      intervention,
    };
  }
}
