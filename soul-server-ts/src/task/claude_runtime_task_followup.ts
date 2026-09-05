import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";
import {
  readClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../engine/claude_background_delivery_metadata.js";
import { readClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";
import { readClaudeSdkSessionMetadata } from
  "../engine/claude_sdk_session_metadata.js";

import type { StartExecutionCallback } from "./task_intervention_route.js";
import type { TaskManager } from "./task_manager.js";
import type { Task } from "./task_models.js";
import { buildClaudeRuntimeFollowupDelivery } from "./claude_runtime_followup_delivery.js";
import { readCanonicalDeliveryPayload } from "./delivery_payload.js";
import {
  buildClaudeRuntimeTaskFollowupPrompt,
  buildFollowupKey,
  type PendingRuntimeTaskFollowup,
} from "./claude_runtime_task_followup_prompt.js";
import { buildClaudeBackgroundGenerationIdentity } from
  "./claude_background_generation_identity.js";
import { hasPendingClaudeBackgroundRuntimeWork } from "./claude_runtime_state.js";
import {
  normalizeRuntimeEventRevision as normalizeEventRevision,
  normalizeRuntimeRevision as normalizeRevision,
  runtimeRecord as asRecord,
  runtimeString as asString,
} from "./claude_runtime_followup_utils.js";

export const CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE = "claude_runtime_task_followup";

export { buildClaudeRuntimeTaskFollowupPrompt } from
  "./claude_runtime_task_followup_prompt.js";

export interface ClaudeRuntimeTaskFollowupPort {
  collect(task: Task, event: SSEEventPayload): void;
  flush(task: Task): Promise<void>;
  collectDetached(task: Task, event: SSEEventPayload): Promise<void>;
}

export interface ClaudeRuntimeTaskFollowupDeps {
  taskManager: Pick<TaskManager, "addIntervention">;
  onResume: StartExecutionCallback;
  releaseRetainedRunner(task: Task): Promise<void>;
  logger: Logger;
  deliveryV2Enabled?: boolean;
  sourceNode: string;
}

const TERMINAL_RUNTIME_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

export class ClaudeRuntimeTaskFollowupController implements ClaudeRuntimeTaskFollowupPort {
  private readonly pendingBySession = new Map<string, Map<string, PendingRuntimeTaskFollowup>>();
  private readonly flushedGenerationKeys = new Set<string>();
  private readonly durableDeliveryByGenerationKey =
    new Map<string, ClaudeBackgroundDeliveryMetadata>();
  private sequence = 0;

  constructor(private readonly deps: ClaudeRuntimeTaskFollowupDeps) {}

  collect(task: Task, event: SSEEventPayload): void {
    const payload = event as Record<string, unknown>;
    const type = asString(payload.type);
    if (
      type !== "claude_runtime_task_notification" &&
      type !== "claude_runtime_task_updated"
    ) {
      return;
    }

    const taskId = asString(payload.task_id);
    if (!taskId) return;
    const runtimeTask = task.claudeRuntime?.tasks[taskId];
    const patch = type === "claude_runtime_task_updated"
      ? asRecord(payload.patch) ?? {}
      : {};
    const sdkSessionId = task.codexThreadId;
    const eventSdkSessionId = asString(payload.session_id) ??
      readClaudeSdkSessionMetadata(event)?.sessionId;
    if (eventSdkSessionId && eventSdkSessionId !== sdkSessionId) return;
    const initiatingToolUseId = asString(payload.tool_use_id) ??
      asString(patch.tool_use_id);
    if (!sdkSessionId || !initiatingToolUseId) return;
    const identity = buildClaudeBackgroundGenerationIdentity({
      sourceNode: this.deps.sourceNode,
      agentSessionId: task.agentSessionId,
      sdkSessionId,
      sdkTaskId: taskId,
      initiatingToolUseId,
    });
    if (this.flushedGenerationKeys.has(identity.generationKey)) return;
    const exactRuntimeTask = runtimeTask?.toolUseId === initiatingToolUseId
      ? runtimeTask
      : undefined;
    const status = asString(payload.status) ?? asString(patch.status) ??
      exactRuntimeTask?.status;
    if (!status || !TERMINAL_RUNTIME_TASK_STATUSES.has(status)) return;
    const isBackgrounded =
      Boolean(readClaudeBackgroundProvenance(event)) ||
      runtimeTask?.isBackgrounded === true ||
      patch.is_backgrounded === true;
    if (!isBackgrounded) return;
    const durableDelivery = readClaudeBackgroundDeliveryMetadata(event);
    if (durableDelivery) {
      if (
        durableDelivery.relationKey !== identity.relationKey ||
        durableDelivery.completionId !== identity.completionId ||
        durableDelivery.deliveryId !== identity.deliveryId
      ) {
        throw new Error(`Claude background generation identity mismatch: ${taskId}`);
      }
      this.durableDeliveryByGenerationKey.set(identity.generationKey, durableDelivery);
    }

    const pending = this.getPendingMap(task.agentSessionId);
    const previous = pending.get(identity.generationKey);
    pending.set(identity.generationKey, {
      ...identity,
      sdkSessionId,
      initiatingToolUseId,
      taskId,
      status,
      outputFile:
        asString(payload.output_file) ?? asString(patch.output_file) ??
        exactRuntimeTask?.outputFile ?? previous?.outputFile,
      summary:
        asString(payload.summary) ?? asString(patch.summary) ??
        exactRuntimeTask?.summary ?? previous?.summary,
      description:
        asString(patch.description) ?? exactRuntimeTask?.description ?? previous?.description,
      toolUseId: initiatingToolUseId,
      error:
        asString(payload.error) ?? asString(patch.error) ??
        exactRuntimeTask?.error ?? previous?.error,
      terminalRevision:
        normalizeEventRevision(payload._event_id) ??
        normalizeEventRevision(patch._event_id) ??
        normalizeRevision(exactRuntimeTask?.endTime ?? exactRuntimeTask?.updatedAt) ??
        previous?.terminalRevision ??
        `${status}:unknown`,
      firstSeen: previous?.firstSeen ?? this.sequence++,
    });
  }

  async flush(task: Task): Promise<void> {
    // interrupt()가 먼저 terminal status를 박은 뒤 현재 execution이 이 메서드에 도달할 수 있다.
    // 이때 addIntervention()은 auto-resume 경로에서 같은 executionPromise를 기다리므로
    // 자기대기 교착이 된다. Pending은 지우지 않고 다음 정상 running turn까지 보존한다.
    if (task.status !== "running") return;
    if (hasPendingClaudeBackgroundRuntimeWork(task)) return;
    await this.flushPending(task);
  }

  async collectDetached(task: Task, event: SSEEventPayload): Promise<void> {
    this.collect(task, event);
    if (hasPendingClaudeBackgroundRuntimeWork(task)) return;
    await this.flushPending(task);
    await this.deps.releaseRetainedRunner(task);
  }

  private async flushPending(task: Task): Promise<void> {
    const pending = this.pendingBySession.get(task.agentSessionId);
    if (!pending || pending.size === 0) return;

    const items = Array.from(pending.values()).sort((a, b) => a.firstSeen - b.firstSeen);
    const durableItems = items.filter((item) =>
      this.durableDeliveryByGenerationKey.has(item.generationKey)
    );
    for (const item of durableItems) {
      await this.flushItems(task, pending, [item]);
    }
    const remaining = items.filter((item) => !durableItems.includes(item));
    for (const item of remaining) {
      await this.flushItems(task, pending, [item]);
    }
    if (pending.size === 0) {
      this.pendingBySession.delete(task.agentSessionId);
    }
  }

  private async flushItems(
    task: Task,
    pending: Map<string, PendingRuntimeTaskFollowup>,
    items: PendingRuntimeTaskFollowup[],
  ): Promise<void> {
    const durable =
      items.length === 1
        ? this.durableDeliveryByGenerationKey.get(items[0]!.generationKey)
        : undefined;
    const storedMessage = durable
      ? readCanonicalDeliveryPayload(durable.storedPayload)
      : undefined;
    const delivery = durable
      ? {
          deliveryId: durable.deliveryId,
          completionId: durable.completionId,
          relationKey: durable.relationKey,
          deliveryIntent: "runtime_followup" as const,
          producerTerminalRevision: durable.producerTerminalRevision,
          deliveryCreatedAt: durable.deliveryCreatedAt,
          storedDeliveryPayload: durable.storedPayload,
          storedDeliveryPayloadHash: durable.storedPayloadHash,
        }
      : this.deps.deliveryV2Enabled === true
        ? buildClaudeRuntimeFollowupDelivery(items)
        : {};
    const intervention = {
      agentSessionId: task.agentSessionId,
      text: storedMessage?.text ?? buildClaudeRuntimeTaskFollowupPrompt(items),
      user: storedMessage?.user ?? "system",
      callerInfo: storedMessage?.callerInfo ??
        { source: "system" as const, display_name: "Soulstream" },
      attachmentPaths: storedMessage?.attachmentPaths,
      context: storedMessage?.context,
      source: durable?.source ?? CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      followupAttempt: 1,
      followupKey: buildFollowupKey(task.agentSessionId, items),
      followupTaskIds:
        storedMessage?.followupTaskIds ?? items.map((item) => item.taskId),
      ...delivery,
    };
    // Claim ownership before crossing into addIntervention: that call can resume the
    // target synchronously and re-enter collectDetached for the same completion.
    const ownedItems = items.map((item) => {
      const generationKey = item.generationKey;
      const durableDelivery = this.durableDeliveryByGenerationKey.get(generationKey);
      pending.delete(generationKey);
      this.flushedGenerationKeys.add(generationKey);
      this.durableDeliveryByGenerationKey.delete(generationKey);
      return { item, generationKey, durableDelivery };
    });
    try {
      await this.deps.taskManager.addIntervention(
        intervention,
        this.deps.onResume,
      );
    } catch (err) {
      for (const { item, generationKey, durableDelivery } of ownedItems) {
        this.flushedGenerationKeys.delete(generationKey);
        pending.set(generationKey, item);
        if (durableDelivery) {
          this.durableDeliveryByGenerationKey.set(generationKey, durableDelivery);
        }
      }
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, taskIds: items.map((item) => item.taskId) },
        "Claude runtime task follow-up intervention failed",
      );
      throw err;
    }
  }

  private getPendingMap(sessionId: string): Map<string, PendingRuntimeTaskFollowup> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, PendingRuntimeTaskFollowup>();
    this.pendingBySession.set(sessionId, created);
    return created;
  }

}
