import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";
import {
  readClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../engine/claude_background_delivery_metadata.js";
import { readClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";

import type { StartExecutionCallback } from "./task_intervention_route.js";
import type { TaskManager } from "./task_manager.js";
import type { Task } from "./task_models.js";
import { buildClaudeRuntimeFollowupDelivery } from "./claude_runtime_followup_delivery.js";
import { readCanonicalDeliveryPayload } from "./delivery_payload.js";
import {
  buildClaudeRuntimeTaskFollowupPrompt,
  buildFollowupKey,
  buildTaskKey,
  type PendingRuntimeTaskFollowup,
} from "./claude_runtime_task_followup_prompt.js";
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
}

const TERMINAL_RUNTIME_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

export class ClaudeRuntimeTaskFollowupController implements ClaudeRuntimeTaskFollowupPort {
  private readonly pendingBySession = new Map<string, Map<string, PendingRuntimeTaskFollowup>>();
  private readonly flushedTaskKeys = new Set<string>();
  private readonly durableDeliveryByTaskKey =
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
    const flushTaskKey = buildTaskKey(task.agentSessionId, taskId);
    if (this.flushedTaskKeys.has(flushTaskKey)) return;
    const runtimeTask = task.claudeRuntime?.tasks[taskId];
    const patch = type === "claude_runtime_task_updated"
      ? asRecord(payload.patch) ?? {}
      : {};
    const status = asString(payload.status) ?? asString(patch.status) ?? runtimeTask?.status;
    if (!status || !TERMINAL_RUNTIME_TASK_STATUSES.has(status)) return;
    const isBackgrounded =
      Boolean(readClaudeBackgroundProvenance(event)) ||
      runtimeTask?.isBackgrounded === true ||
      patch.is_backgrounded === true;
    if (!isBackgrounded) return;
    const durableDelivery = readClaudeBackgroundDeliveryMetadata(event);
    if (durableDelivery) {
      this.durableDeliveryByTaskKey.set(flushTaskKey, durableDelivery);
    }

    const pending = this.getPendingMap(task.agentSessionId);
    const previous = pending.get(taskId);
    pending.set(taskId, {
      taskId,
      status,
      outputFile:
        asString(payload.output_file) ?? asString(patch.output_file) ??
        runtimeTask?.outputFile ?? previous?.outputFile,
      summary:
        asString(payload.summary) ?? asString(patch.summary) ??
        runtimeTask?.summary ?? previous?.summary,
      description:
        runtimeTask?.description ?? asString(patch.description) ?? previous?.description,
      toolUseId:
        runtimeTask?.toolUseId ?? asString(payload.tool_use_id) ??
        asString(patch.tool_use_id) ?? previous?.toolUseId,
      error:
        asString(payload.error) ?? asString(patch.error) ??
        runtimeTask?.error ?? previous?.error,
      terminalRevision:
        normalizeEventRevision(payload._event_id) ??
        normalizeEventRevision(patch._event_id) ??
        normalizeRevision(runtimeTask?.endTime ?? runtimeTask?.updatedAt) ??
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
      this.durableDeliveryByTaskKey.has(buildTaskKey(task.agentSessionId, item.taskId))
    );
    for (const item of durableItems) {
      await this.flushItems(task, pending, [item]);
    }
    const remaining = items.filter((item) => !durableItems.includes(item));
    if (remaining.length > 0) {
      await this.flushItems(task, pending, remaining);
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
        ? this.durableDeliveryByTaskKey.get(
            buildTaskKey(task.agentSessionId, items[0]!.taskId),
          )
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
        ? buildClaudeRuntimeFollowupDelivery(task, items)
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
      const taskKey = buildTaskKey(task.agentSessionId, item.taskId);
      const durableDelivery = this.durableDeliveryByTaskKey.get(taskKey);
      pending.delete(item.taskId);
      this.flushedTaskKeys.add(taskKey);
      this.durableDeliveryByTaskKey.delete(taskKey);
      return { item, taskKey, durableDelivery };
    });
    try {
      await this.deps.taskManager.addIntervention(
        intervention,
        this.deps.onResume,
      );
    } catch (err) {
      for (const { item, taskKey, durableDelivery } of ownedItems) {
        this.flushedTaskKeys.delete(taskKey);
        pending.set(item.taskId, item);
        if (durableDelivery) {
          this.durableDeliveryByTaskKey.set(taskKey, durableDelivery);
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
