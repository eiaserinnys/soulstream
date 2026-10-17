import type { Logger } from "pino";

import type { AgentProfile } from "../agent_registry.js";
import {
  type BackendRolloverContext,
  composeFirstTurnPrompt,
  type ExecutionContextBuilder,
  type FollowupContext,
  type PreparedContext,
} from "../context/context_builder.js";
import type { PersistentCheckpointStats } from "../context/persistent_checkpoint.js";
import { formatContextItems } from "../context/prompt_assembler.js";

import { splitAttachmentPaths } from "./attachment_context.js";
import { appendAttachmentPathNotes } from "./attachment_path_note.js";
import { truncateClaudeTextToEstimatedTokens } from "./claude_context_recovery.js";
import { buildDeliveryInputUuid } from "./delivery_identity.js";
import { dequeueNextTurnInterventions } from "./task_intervention_queue.js";
import type { InterventionMessage, Task } from "./task_models.js";
import { composeInterventionTurnPrompt } from "./task_turn_loop_transition.js";
import { effectiveTaskBackend } from "./task_model_preset.js";
import { isSessionDataHostError } from "../control_plane/session_data_host_client.js";
import type { TurnOrigin } from "../engine/protocol.js";
import { interventionTurnOrigin } from "./turn_origin.js";
import {
  buildBoundedBackendRolloverPrompt,
  composeBackendRolloverInterventions,
  copyAttachmentSource,
  createInterventionAttachmentSource,
  createTaskAttachmentSource,
  prepareGenerationTurnInput,
  truncateWithNotice,
  type BackendRolloverReplayBase,
} from "./generation_turn_input.js";
import { isCacheKeepaliveInput } from "./persistent_keepalive_marker.js";
import {
  type AttachmentTurnSource,
  type PreparedAttachmentInput,
  type PrepareAttachmentInput,
} from "./prepare_attachment_input.js";

export function buildFollowupInputUuid(interventions: InterventionMessage[]): string | undefined {
  if (interventions.length === 1) {
    const deliveryId = interventions[0]?.deliveryId;
    return deliveryId ? buildDeliveryInputUuid(deliveryId) : undefined;
  }
  if (interventions.length > 1) {
    const deliveryIds = interventions.map((intervention) => intervention.deliveryId);
    if (deliveryIds.some((deliveryId) => !deliveryId)) return undefined;
    return buildDeliveryInputUuid(`batch:${deliveryIds.join(",")}`);
  }
  return undefined;
}

export const CLAUDE_ROLLOVER_PROMPT_MAX_CHARS = 80_000;
export const CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_CHARS = 60_000;
export const CLAUDE_ROLLOVER_PROMPT_MAX_ESTIMATED_TOKENS = 100_000;
export const CLAUDE_ROLLOVER_SYSTEM_PROMPT_MAX_ESTIMATED_TOKENS = 50_000;
export interface TaskTurnInput {
  prompt: string;
  /** Original initial user text, before dynamic context assembly; only for rollover replay. */
  originalPrompt?: string;
  imageAttachmentPaths: string[];
  systemPrompt?: string;
  inputUuid?: string;
  runnerInterventionId?: string;
  runnerInterventionIds?: string[];
  turnOrigin?: TurnOrigin;
  interventions?: InterventionMessage[];
  /** Raw initial attachment source retained so a backend rollover can rebuild cache files. */
  attachmentSource?: AttachmentTurnSource;
  backendSessionRolloverFrom?: string;
  generationRollover?: boolean;
  generationCheckpointStats?: PersistentCheckpointStats;
}

export interface TaskTurnInputBuilderDeps {
  contextBuilder?: ExecutionContextBuilder;
  initialMessagePublisher: TaskInitialMessagePublisherPort;
  logger: Logger;
  prepareAttachmentInput?: PrepareAttachmentInput;
  waitForAttachmentRefs?: (sessionId: string) => Promise<unknown>;
}

export interface TaskInitialMessagePublisherPort {
  publishInitialMessages(task: Task, ctx?: PreparedContext, inputId?: string): Promise<void>;
  publishContextManifestBestEffort(task: Task, manifest: NonNullable<PreparedContext["contextManifest"]>): Promise<void>;
}

export class TaskTurnInputBuilder {
  constructor(private readonly deps: TaskTurnInputBuilderDeps) {}

  async prepareInitialTurnInput(task: Task, agent: AgentProfile): Promise<TaskTurnInput> {
    if (task.activeGenerationRollover) {
      const interventions = dequeueNextTurnInterventions(task);
      const contextBuilder = this.deps.contextBuilder;
      if (!contextBuilder) {
        throw new Error("Execution context builder is required for generation rollover");
      }
      const deliveryId = interventions[0]?.deliveryId;
      const inputUuid = deliveryId ? buildDeliveryInputUuid(deliveryId) : undefined;
      const context = inputUuid
        ? await contextBuilder.buildGenerationContext(task, agent, inputUuid)
        : await contextBuilder.buildGenerationContext(task, agent);
      if (context.contextManifest) {
        await this.deps.initialMessagePublisher.publishContextManifestBestEffort(task, context.contextManifest);
      }
      const preparedInterventions = await this.prepareInterventionCopies(task, interventions);
      return prepareGenerationTurnInput(task, agent, context, preparedInterventions, interventions);
    }
    if (task.interventionQueue.length > 0) {
      return this.prepareFollowupTurnInput(
        task,
        agent,
        dequeueNextTurnInterventions(task),
      );
    }

    if (task.creationEffects) await task.creationEffects;

    const inputUuid = task.executionRegistration
      ? buildDeliveryInputUuid(task.executionRegistration.executionCommandId)
      : undefined;
    const ctx = await this.buildContext(task, agent, inputUuid);
    if (inputUuid) {
      await this.deps.initialMessagePublisher.publishInitialMessages(task, ctx, inputUuid);
    } else {
      await this.deps.initialMessagePublisher.publishInitialMessages(task, ctx);
    }
    this.recordInitialContextInjection(task);

    const attachmentSource = createTaskAttachmentSource(task);
    const preparedAttachmentInput = attachmentSource
      ? await this.prepareAttachmentSources([attachmentSource]).then((prepared) => prepared[0])
      : undefined;
    return this.prepareNewTaskTurnInput(
      task,
      agent,
      ctx,
      inputUuid,
      preparedAttachmentInput,
      attachmentSource,
    );
  }

  async prepareFollowupTurnInput(
    task: Task,
    agent: AgentProfile,
    interventions: InterventionMessage[],
  ): Promise<TaskTurnInput> {
    const firstIntervention = interventions[0];
    if (!firstIntervention) throw new Error("follow-up turn requires an intervention");
    const currentCallerInfo = interventions.at(-1)?.callerInfo ?? task.callerInfo;
    const inputUuid = buildFollowupInputUuid(interventions);
    const includeFullContext = task.needsFullContextReinjection === true;
    const includeClaudeSessionIdUpdate =
      Boolean(task.codexThreadId) &&
      task.lastInjectedClaudeSessionId !== task.codexThreadId;
    const ctx = await this.buildFollowupContext(task, agent, {
      includeFullContext,
      includeClaudeSessionIdUpdate,
      previousCallerInfo: task.lastInjectedCallerInfo,
      currentCallerInfo,
      inputId: inputUuid ?? null,
    });
    if (includeFullContext) {
      task.needsFullContextReinjection = false;
    }

    if (ctx) {
      this.recordFollowupContextInjection(task, currentCallerInfo);
    }

    const preparedInterventions = await this.prepareInterventionCopies(task, interventions);
    const composed = composeInterventionTurnPrompt(preparedInterventions.map(message=>({...message,context:message.context?.filter(item=>item.key !== "assigned_cards")})));
    const contextItems = ctx?.contextItems ?? [];
    const followupContextItems = isCacheKeepaliveInput(firstIntervention)
      ? contextItems.filter((item) => item.key !== "assigned_cards")
      : contextItems;
    const prompt = appendContextBlock(composed.prompt, followupContextItems);
    const systemPrompt =
      ["claude", "antigravity", "opencode"].includes(effectiveTaskBackend(task, agent)) && includeFullContext
        ? ctx?.effectiveSystemPrompt
        : undefined;
    const runnerInterventionIds = interventions
      .map((message) => message.runnerInterventionId)
      .filter((id): id is string => id !== undefined);
    return {
      prompt,
      imageAttachmentPaths: composed.imageAttachmentPaths,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(inputUuid ? { inputUuid } : {}),
      ...(firstIntervention.runnerInterventionId
        ? { runnerInterventionId: firstIntervention.runnerInterventionId }
        : {}),
      ...(runnerInterventionIds.length > 0 ? { runnerInterventionIds } : {}),
      turnOrigin: interventionTurnOrigin(firstIntervention, inputUuid),
      interventions,
    };
  }

  async prepareBackendRolloverTurnInput(
    task: Task,
    agent: AgentProfile,
    failedInput: TaskTurnInput,
    backendSessionRolloverFrom: string,
  ): Promise<TaskTurnInput> {
    const currentCallerInfo = failedInput.interventions?.at(-1)?.callerInfo ?? task.callerInfo;
    const taskForContext = currentCallerInfo
      ? { ...task, callerInfo: currentCallerInfo }
      : task;
    const ctx = await this.buildBackendRolloverContext(taskForContext, agent);
    task.needsFullContextReinjection = false;
    this.recordFollowupContextInjection(task, currentCallerInfo);

    let replayBase: BackendRolloverReplayBase;
    let attachmentSource = failedInput.attachmentSource;
    if (failedInput.interventions !== undefined) {
      const preparedInterventions = await this.prepareInterventionCopies(task, failedInput.interventions);
      replayBase = composeBackendRolloverInterventions(preparedInterventions);
    } else if (attachmentSource) {
      attachmentSource = copyAttachmentSource(attachmentSource);
      const prepared = (await this.prepareAttachmentSources([attachmentSource]))[0]!;
      replayBase = {
        prompt: prepared.text,
        imageAttachmentPaths: prepared.imageAttachmentPaths,
        attachmentNotePaths: prepared.attachmentPaths,
      };
    } else {
      replayBase = {
        // Legacy replay has no durable attachment source to rebuild.
        prompt: failedInput.originalPrompt ?? failedInput.prompt,
        imageAttachmentPaths: failedInput.imageAttachmentPaths,
      };
    }
    return {
      prompt: buildBoundedBackendRolloverPrompt(replayBase.prompt, ctx, {
        maxChars: CLAUDE_ROLLOVER_PROMPT_MAX_CHARS,
        maxEstimatedTokens: CLAUDE_ROLLOVER_PROMPT_MAX_ESTIMATED_TOKENS,
      }, replayBase.attachmentNotePaths),
      originalPrompt: replayBase.prompt,
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
      ...(failedInput.runnerInterventionId !== undefined
        ? { runnerInterventionId: failedInput.runnerInterventionId }
        : {}),
      ...(failedInput.runnerInterventionIds !== undefined
        ? { runnerInterventionIds: failedInput.runnerInterventionIds }
        : {}),
      ...(failedInput.turnOrigin !== undefined
        ? { turnOrigin: failedInput.turnOrigin }
        : {}),
      ...(failedInput.interventions !== undefined
        ? { interventions: failedInput.interventions }
        : {}),
      ...(attachmentSource !== undefined ? { attachmentSource } : {}),
      backendSessionRolloverFrom,
    };
  }

  private async prepareAttachmentSources(
    sources: readonly AttachmentTurnSource[],
  ): Promise<Array<PreparedAttachmentInput | undefined>> {
    if (!sources.some((source) => (source.attachmentIds?.length ?? 0) > 0)) {
      return sources.map(() => undefined);
    }
    const prepare = this.deps.prepareAttachmentInput;
    if (!prepare) throw new Error("ATTACHMENT_INPUT_UNAVAILABLE");
    await this.deps.waitForAttachmentRefs?.(sources[0]!.sessionId);

    const prepared: Array<PreparedAttachmentInput | undefined> = [];
    for (const source of sources) {
      prepared.push((source.attachmentIds?.length ?? 0) > 0 ? await prepare(source) : undefined);
    }
    return prepared;
  }

  private async prepareInterventionCopies(
    task: Task,
    interventions: InterventionMessage[],
  ): Promise<InterventionMessage[]> {
    const sourceEntries = interventions.flatMap((message, index) => {
      const source = createInterventionAttachmentSource(task.agentSessionId, message);
      return source ? [{ index, source }] : [];
    });
    if (sourceEntries.length === 0) return interventions;

    const prepared = await this.prepareAttachmentSources(sourceEntries.map(({ source }) => source));
    const preparedByIndex = new Map<number, PreparedAttachmentInput>();
    sourceEntries.forEach(({ index }, preparedIndex) => {
      const value = prepared[preparedIndex];
      if (value) preparedByIndex.set(index, value);
    });
    return interventions.map((message, index) => {
      const value = preparedByIndex.get(index);
      return value
        ? { ...message, text: value.text, attachmentPaths: value.attachmentPaths }
        : message;
    });
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
        { err: error, sessionId: task.agentSessionId },
        "Backend rollover context failed; continuing with metadata-only recovery",
      );
      return { contextItems: [] };
    }
  }

  private async buildContext(
    task: Task,
    agent: AgentProfile,
    inputId?: string,
  ): Promise<PreparedContext | undefined> {
    if (!this.deps.contextBuilder) {
      return undefined;
    }

    try {
      return inputId
        ? await this.deps.contextBuilder.build(task, agent, inputId)
        : await this.deps.contextBuilder.build(task, agent);
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
    inputUuid?: string,
    preparedAttachmentInput?: PreparedAttachmentInput,
    attachmentSource?: AttachmentTurnSource,
  ): TaskTurnInput {
    const rawText = attachmentSource?.text ?? task.prompt;
    const currentPaths = preparedAttachmentInput?.attachmentPaths ?? task.attachmentPaths ?? [];
    const promptText = preparedAttachmentInput
      ? appendAttachmentPathNotes(preparedAttachmentInput.text, currentPaths)
      : task.prompt;
    const imageAttachmentPaths = preparedAttachmentInput?.imageAttachmentPaths
      ?? splitAttachmentPaths(task.attachmentPaths).imagePaths;
    const replayFields = attachmentSource ? { attachmentSource, originalPrompt: rawText } : { originalPrompt: task.prompt };
    const backend = effectiveTaskBackend(task, agent);
    if (!ctx) {
      return {
        prompt: promptText,
        ...replayFields,
        imageAttachmentPaths,
        ...(backend === "antigravity" || backend === "opencode" ? { systemPrompt: "" } : {}),
        ...(inputUuid ? { inputUuid } : {}),
        turnOrigin: { kind: "initial_prompt" },
      };
    }

    if (["claude", "antigravity", "opencode"].includes(backend)) {
      return {
        ...replayFields,
        prompt: composeFirstTurnPrompt({
          effectiveSystemPrompt: undefined,
          combinedContextItems: ctx.combinedContextItems,
          assembledPrompt: promptText,
        }),
        imageAttachmentPaths,
        ...(inputUuid ? { inputUuid } : {}),
        ...(backend === "antigravity" || backend === "opencode"
          ? { systemPrompt: ctx.effectiveSystemPrompt ?? "" }
          : ctx.effectiveSystemPrompt !== undefined
          ? { systemPrompt: ctx.effectiveSystemPrompt }
          : {}),
        turnOrigin: { kind: "initial_prompt" },
      };
    }

    return {
      ...replayFields,
      prompt: composeFirstTurnPrompt({
        ...ctx,
      assembledPrompt: promptText,
      }),
      imageAttachmentPaths,
      ...(inputUuid ? { inputUuid } : {}),
      turnOrigin: { kind: "initial_prompt" },
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
