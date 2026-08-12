import type { Logger } from "pino";

import type { AgentProfile } from "../agent_registry.js";
import {
  type BackendRolloverContext,
  composeFirstTurnPrompt,
  type ExecutionContextBuilder,
  type FollowupContext,
  type PreparedContext,
} from "../context/context_builder.js";
import { formatContextItems } from "../context/prompt_assembler.js";

import { splitAttachmentPaths } from "./attachment_context.js";
import { truncateClaudeTextToEstimatedTokens } from "./claude_context_recovery.js";
import { buildDeliveryInputUuid } from "./delivery_identity.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";
import { effectiveTaskBackend } from "./task_model_preset.js";
import { isSessionDataHostError } from "../control_plane/session_data_host_client.js";

export const CLAUDE_ROLLOVER_PROMPT_MAX_CHARS = 80_000;
export const CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_CHARS = 60_000;
export const CLAUDE_ROLLOVER_PROMPT_MAX_ESTIMATED_TOKENS = 100_000;
export const CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_ESTIMATED_TOKENS = 50_000;
const CLAUDE_ROLLOVER_REPLAY_INPUT_MAX_CHARS = 40_000;
const CLAUDE_ROLLOVER_CONTEXT_MAX_CHARS = 20_000;
const CLAUDE_ROLLOVER_HISTORY_BLOCK_MAX_CHARS = 14_000;

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
    const taskForContext = currentCallerInfo
      ? { ...task, callerInfo: currentCallerInfo }
      : task;
    const ctx = await this.buildBackendRolloverContext(taskForContext, agent);
    task.needsFullContextReinjection = false;
    this.recordFollowupContextInjection(task, currentCallerInfo);

    const replayBase = failedInput.intervention
      ? composeInterventionTurnPrompt(failedInput.intervention)
      : {
          prompt: failedInput.prompt,
          imageAttachmentPaths: failedInput.imageAttachmentPaths,
        };
    return {
      prompt: buildBoundedBackendRolloverPrompt(replayBase.prompt, ctx),
      imageAttachmentPaths: replayBase.imageAttachmentPaths,
      ...(ctx.effectiveSystemPrompt !== undefined
        ? {
            systemPrompt: truncateClaudeTextToEstimatedTokens(
              truncateWithNotice(
                ctx.effectiveSystemPrompt,
                CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_CHARS,
                "system prompt",
              ),
              CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_ESTIMATED_TOKENS,
              "system prompt",
            ),
          }
        : {}),
      ...(failedInput.inputUuid !== undefined ? { inputUuid: failedInput.inputUuid } : {}),
      ...(failedInput.intervention !== undefined
        ? { intervention: failedInput.intervention }
        : {}),
      backendSessionRolloverFrom,
    };
  }

  private async buildBackendRolloverContext(
    task: Task,
    agent: AgentProfile,
  ): Promise<BackendRolloverContext> {
    const builder = this.deps.contextBuilder;
    if (!builder) return { contextItems: [] };
    try {
      if (typeof builder.buildBackendRolloverContext === "function") {
        return await builder.buildBackendRolloverContext(task, agent);
      }
      return await builder.buildFollowupContext(task, agent, {
        includeFullContext: true,
        includeClaudeSessionIdUpdate: false,
        previousCallerInfo: task.lastInjectedCallerInfo,
        currentCallerInfo: task.callerInfo,
      });
    } catch (error) {
      this.deps.logger.warn(
        { error, sessionId: task.agentSessionId },
        "Backend rollover context failed; continuing with metadata-only recovery",
      );
      return { contextItems: [] };
    }
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

function buildBoundedBackendRolloverPrompt(
  replayPrompt: string,
  context: BackendRolloverContext,
): string {
  const excerpt = context.currentSessionExcerpt;
  const includedTurns = excerpt?.turns.length ?? 0;
  const coverage = excerpt
    ? `${includedTurns.toLocaleString("en-US")} recent conversation records were carried from `
      + `${excerpt.totalEvents.toLocaleString("en-US")} total session events; `
      + "older or omitted context "
      + "may be missing."
    : "No prior conversation excerpt was available; all backend-only conversation context "
      + "may be missing.";
  const notice = [
    "<claude_backend_rollover>",
    "The previous Claude backend session exceeded its context window and was replaced.",
    coverage,
    "Before making irreversible changes, re-check the current task, files, and external state.",
    "</claude_backend_rollover>",
  ].join("\n");
  const history = excerpt && excerpt.turns.length > 0
    ? truncateWithNotice(
        `<recent_session_history>\n${JSON.stringify(excerpt.turns, null, 2)}\n`
          + "</recent_session_history>",
        CLAUDE_ROLLOVER_HISTORY_BLOCK_MAX_CHARS,
        "recent session history",
      )
    : "";
  const boundedReplay = truncateWithNotice(
    replayPrompt,
    CLAUDE_ROLLOVER_REPLAY_INPUT_MAX_CHARS,
    "replayed input",
  );
  const contextBlock = truncateWithNotice(
    formatContextItems(context.contextItems),
    CLAUDE_ROLLOVER_CONTEXT_MAX_CHARS,
    "dynamic context",
  );
  const sections = [
    notice,
    history,
    `<replayed_input>\n${boundedReplay}\n</replayed_input>`,
    contextBlock,
  ].filter((value) => value.length > 0);
  return truncateClaudeTextToEstimatedTokens(
    truncateWithNotice(
      sections.join("\n\n"),
      CLAUDE_ROLLOVER_PROMPT_MAX_CHARS,
      "rollover prompt",
    ),
    CLAUDE_ROLLOVER_PROMPT_MAX_ESTIMATED_TOKENS,
    "rollover prompt",
  );
}

function truncateWithNotice(value: string, limit: number, label: string): string {
  if (value.length <= limit) return value;
  const suffix = `\n[${label} truncated by ${value.length - limit} characters]`;
  if (suffix.length >= limit) return value.slice(0, limit);
  return `${value.slice(0, limit - suffix.length)}${suffix}`;
}
