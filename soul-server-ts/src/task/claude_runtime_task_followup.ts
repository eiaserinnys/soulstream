import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";
import { isPostResultDrainEvent } from "../engine/claude_event_phase.js";
import {
  readClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../engine/claude_background_delivery_metadata.js";
import { readClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";

import type { StartExecutionCallback } from "./task_intervention_route.js";
import type { TaskManager } from "./task_manager.js";
import type { InterventionMessage, Task } from "./task_models.js";
import type { TaskDeliveryLedgerGate } from "./task_delivery_ledger_gate.js";
import {
  buildClaudeRuntimeFollowupDelivery,
  buildClaudeRuntimeFollowupFallbackDelivery,
} from "./claude_runtime_followup_delivery.js";
import { readCanonicalDeliveryPayload } from "./delivery_payload.js";
import {
  buildClaudeRuntimeTaskFollowupFallbackPrompt,
  buildClaudeRuntimeTaskFollowupPrompt,
  buildFollowupKey,
  buildRefreshedClaudeRuntimeTaskFollowupPrompt,
  buildTaskKey,
  type PendingRuntimeTaskFollowup,
} from "./claude_runtime_task_followup_prompt.js";
import { hasPendingClaudeBackgroundRuntimeWork } from "./claude_runtime_state.js";

export { buildClaudeRuntimeTaskFollowupPrompt } from
  "./claude_runtime_task_followup_prompt.js";

export const CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE = "claude_runtime_task_followup";
export const MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT = 3;
export const CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS: Readonly<Record<number, number>> = {
  2: 5_000,
  3: 30_000,
};

export type ClaudeRuntimeFollowupStallReason =
  | "empty_response"
  | "repeated_response";

export interface ClaudeRuntimeTaskFollowupPort {
  collect(task: Task, event: SSEEventPayload): void;
  flush(task: Task): Promise<void>;
  collectDetached(task: Task, event: SSEEventPayload): Promise<void>;
  queueFallback(
    task: Task,
    message: InterventionMessage,
    reason: ClaudeRuntimeFollowupStallReason,
  ): Promise<void>;
  cancelScheduledFallback(task: Task, supersedingMessage: InterventionMessage): void;
  takeScheduledFallbacks(): ClaudeRuntimeScheduledFallback[];
}

export interface ClaudeRuntimeScheduledFallback {
  task: Task;
  message: InterventionMessage;
  reason: ClaudeRuntimeFollowupStallReason;
}

export interface ClaudeRuntimeTaskFollowupDeps {
  taskManager: Pick<TaskManager, "addIntervention">;
  onResume: StartExecutionCallback;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  deliveryV2Enabled?: boolean;
  inlineConsumptionRecorder?: Pick<TaskDeliveryLedgerGate, "recordInlineConsumed">;
}

interface ScheduledRuntimeTaskFallback {
  sessionId: string;
  token: symbol;
  promise: Promise<void>;
  pending: ClaudeRuntimeScheduledFallback;
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
  private readonly scheduledFallbacks = new Map<string, ScheduledRuntimeTaskFallback>();
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
      inlineObserved:
        (previous?.inlineObserved ?? true) && !isPostResultDrainEvent(event),
    });
  }

  async flush(task: Task): Promise<void> {
    // interrupt()가 먼저 terminal status를 박은 뒤 현재 execution이 이 메서드에 도달할 수 있다.
    // 이때 addIntervention()은 auto-resume 경로에서 같은 executionPromise를 기다리므로
    // 자기대기 교착이 된다. Pending은 지우지 않고 다음 정상 running turn까지 보존한다.
    if (task.status !== "running") return;
    await this.flushPending(task);
  }

  async collectDetached(task: Task, event: SSEEventPayload): Promise<void> {
    this.collect(task, event);
    if (hasPendingClaudeBackgroundRuntimeWork(task)) return;
    await this.flushPending(task);
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
    try {
      const consumedInline =
        items.every((item) => item.inlineObserved) &&
        this.deps.inlineConsumptionRecorder
          ? await this.deps.inlineConsumptionRecorder.recordInlineConsumed(
              intervention,
              task,
            )
          : false;
      if (!consumedInline) {
        await this.deps.taskManager.addIntervention(
          intervention,
          this.deps.onResume,
        );
      }
      for (const item of items) {
        pending.delete(item.taskId);
        const taskKey = buildTaskKey(task.agentSessionId, item.taskId);
        this.flushedTaskKeys.add(taskKey);
        this.durableDeliveryByTaskKey.delete(taskKey);
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, taskIds: items.map((item) => item.taskId) },
        "Claude runtime task follow-up intervention failed",
      );
      throw err;
    }
  }

  queueFallback(
    task: Task,
    message: InterventionMessage,
    reason: ClaudeRuntimeFollowupStallReason,
  ): Promise<void> {
    const attempt = (message.followupAttempt ?? 1) + 1;
    const followupKey = message.followupKey ?? `${task.agentSessionId}:attempt:${attempt}`;
    const existing = this.scheduledFallbacks.get(followupKey);
    if (existing) return existing.promise;

    const delayMs = resolveFallbackDelayMs(attempt);
    const token = Symbol(followupKey);
    const executionPromise = task.executionPromise;
    task.pendingClaudeRuntimeFollowupRetry = true;

    const promise = this.deliverFallbackAfterDelay({
      task,
      message,
      reason,
      attempt,
      followupKey,
      delayMs,
      token,
      executionPromise,
    }).finally(() => {
      if (this.scheduledFallbacks.get(followupKey)?.token === token) {
        this.scheduledFallbacks.delete(followupKey);
      }
      if (!this.hasScheduledFallback(task.agentSessionId)) {
        task.pendingClaudeRuntimeFollowupRetry = false;
      }
    });
    this.scheduledFallbacks.set(followupKey, {
      sessionId: task.agentSessionId,
      token,
      promise,
      pending: { task, message, reason },
    });
    this.deps.logger.info(
      { sessionId: task.agentSessionId, followupKey, attempt, delayMs },
      "Claude runtime task follow-up fallback scheduled after terminal drain",
    );
    return promise;
  }

  cancelScheduledFallback(task: Task, supersedingMessage: InterventionMessage): void {
    if (supersedingMessage.source === CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE) return;

    let cancelled = 0;
    for (const [followupKey, scheduled] of this.scheduledFallbacks) {
      if (scheduled.sessionId !== task.agentSessionId) continue;
      this.scheduledFallbacks.delete(followupKey);
      cancelled += 1;
    }
    if (cancelled === 0) return;

    task.pendingClaudeRuntimeFollowupRetry = false;
    this.deps.logger.info(
      { sessionId: task.agentSessionId, cancelled },
      "Claude runtime task follow-up fallback cancelled by a newer message",
    );
  }

  takeScheduledFallbacks(): ClaudeRuntimeScheduledFallback[] {
    const scheduled = Array.from(this.scheduledFallbacks.values());
    this.scheduledFallbacks.clear();
    for (const { pending } of scheduled) {
      pending.task.pendingClaudeRuntimeFollowupRetry = false;
    }
    if (scheduled.length > 0) {
      this.deps.logger.warn(
        { count: scheduled.length },
        "Claude runtime task follow-up fallbacks cancelled by server shutdown",
      );
    }
    return scheduled.map(({ pending }) => pending);
  }

  private async deliverFallbackAfterDelay(params: {
    task: Task;
    message: InterventionMessage;
    reason: ClaudeRuntimeFollowupStallReason;
    attempt: number;
    followupKey: string;
    delayMs: number;
    token: symbol;
    executionPromise: Promise<void> | undefined;
  }): Promise<void> {
    const {
      task,
      message,
      reason,
      attempt,
      followupKey,
      delayMs,
      token,
      executionPromise,
    } = params;

    if (executionPromise) {
      try {
        await executionPromise;
      } catch {
        // The executor persists its terminal state before the delayed retry.
      }
    }
    if (!this.isCurrentFallback(followupKey, token)) return;
    await (this.deps.sleep ?? sleep)(delayMs);
    if (!this.isCurrentFallback(followupKey, token)) return;

    task.pendingClaudeRuntimeFollowupRetry = false;
    const refreshedPrompt = buildRefreshedClaudeRuntimeTaskFollowupPrompt(task, message);
    const fallbackText = buildClaudeRuntimeTaskFollowupFallbackPrompt(
      refreshedPrompt ?? message.text,
      reason,
    );
    const fallbackDelivery = this.deps.deliveryV2Enabled === true
      ? buildClaudeRuntimeFollowupFallbackDelivery(task, message, {
          text: fallbackText,
          reason,
          attempt,
          followupTaskIds: message.followupTaskIds,
        })
      : {
          deliveryId: message.deliveryId,
          deliveryIntent: message.deliveryIntent,
          completionId: message.completionId,
          relationKey: message.relationKey,
          producerTerminalRevision: message.producerTerminalRevision,
          parentDeliveryId: message.parentDeliveryId,
          callerTurnId: message.callerTurnId,
          deliveryCreatedAt: message.deliveryCreatedAt,
        };
    try {
      const result = await this.deps.taskManager.addIntervention(
        {
          agentSessionId: task.agentSessionId,
          text: fallbackText,
          user: "system",
          callerInfo: message.callerInfo ?? { source: "system", display_name: "Soulstream" },
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          followupAttempt: attempt,
          followupKey,
          followupTaskIds: message.followupTaskIds,
          ...fallbackDelivery,
          callerTurnId: message.callerTurnId,
          onlyIfTerminal: this.deps.deliveryV2Enabled !== true,
        },
        this.deps.onResume,
      );
      if ("deferred" in result && result.deferred) {
        this.deps.logger.info(
          { sessionId: task.agentSessionId, followupKey, attempt },
          "Claude runtime task follow-up fallback skipped because another turn is running",
        );
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, followupKey, reason },
        "Claude runtime task follow-up fallback intervention failed",
      );
      throw err;
    }
  }

  private isCurrentFallback(followupKey: string, token: symbol): boolean {
    return this.scheduledFallbacks.get(followupKey)?.token === token;
  }

  private hasScheduledFallback(sessionId: string): boolean {
    return Array.from(this.scheduledFallbacks.values()).some(
      (scheduled) => scheduled.sessionId === sessionId,
    );
  }

  private getPendingMap(sessionId: string): Map<string, PendingRuntimeTaskFollowup> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, PendingRuntimeTaskFollowup>();
    this.pendingBySession.set(sessionId, created);
    return created;
  }

}

function resolveFallbackDelayMs(attempt: number): number {
  const delayMs = CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS[attempt];
  if (delayMs === undefined) {
    throw new Error(`No Claude runtime follow-up retry delay configured for attempt ${attempt}`);
  }
  return delayMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function normalizeRevision(value: number | undefined): string | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : String(value);
}

function normalizeEventRevision(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
