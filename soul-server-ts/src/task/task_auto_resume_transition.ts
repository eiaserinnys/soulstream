import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";

import {
  createExecutionActivation,
  isTerminalTaskStatus,
  type CallerInfo,
  type ExecutionActivation,
  type InterventionMessage,
  type Task,
} from "./task_models.js";
import { enqueueInterventionOnce } from "./task_intervention_queue.js";
import { hasLiveExecutionEvidence } from "./task_execution_evidence.js";
import { buildCallerInfoMetadataEntry } from "./task_metadata.js";
import { releaseTaskRunner } from "./task_runner_release.js";
import { reviewStateAfterFollowup } from "./session_review.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import {
  buildUserMessageEvent,
  finishUserMessageEvent,
  persistUserMessageEvent,
} from "./task_user_message_events.js";

export type AutoResumeCallback = (
  task: Task,
  activation?: ExecutionActivation,
) => void | Promise<void>;

export interface AutoResumeTransitionDeps {
  logger: Logger;
  persistence?: EventPersistence;
  contextBuilder?: ExecutionContextBuilder;
  agentRegistry?: AgentRegistry;
}

/**
 * Auto-resume transition for terminal and ownerless-running tasks.
 *
 * Owns the ordered side effects that turn a completed/error/interrupted task
 * back into a running task for the next user turn:
 * resume capability validation -> caller metadata promotion -> user_message
 * persistence + separate durable running effect -> post-transition durable
 * admission -> task state transition -> user_message broadcast -> executor
 * resume callback. Orch projects the running status from the durable effect,
 * so a closed host WebSocket cannot lose the transition.
 */
export class AutoResumeTransition {
  constructor(private readonly deps: AutoResumeTransitionDeps) {}

  async resumeQueuedAfterTerminal(
    task: Task,
    onResume: AutoResumeCallback,
  ): Promise<boolean> {
    if (!isTerminalTaskStatus(task.status)) return false;
    const message = task.interventionQueue[0];
    if (!message) return false;
    await this.resume(task, message, onResume, { publishUserMessage: false });
    return true;
  }

  async resume(
    task: Task,
    message: InterventionMessage,
    onResume: AutoResumeCallback,
    options: {
      publishUserMessage?: boolean;
      afterRunningTransition?: () => Promise<void>;
    } = {},
  ): Promise<{ autoResumed: true }> {
    const originalStatus = task.status;
    if (originalStatus === "running" && hasLiveExecutionEvidence(task)) {
      throw new Error(
        `auto-resume running transition rejected for ${task.agentSessionId}`,
      );
    }
    this.requireResumableProfile(task);
    const transitionRevision = task.lastEventId;
    const expectedTerminalEventId = isTerminalTaskStatus(originalStatus)
      ? task.terminalEventId ?? null
      : undefined;
    const originalTerminalEventId = task.terminalEventId;
    const activation = createExecutionActivation();
    task.status = "initializing";
    task.executionActivation = activation;
    void activation.promise.catch(() => undefined);

    try {
      await this.awaitExecutionDrain(task);
      await this.closeStaleEngine(task);
      await this.promoteCallerInfo(task, message.callerInfo);

      const userMessageEvent = options.publishUserMessage === false
        ? null
        : buildUserMessageEvent({
          text: message.text,
          user: message.user,
          callerInfo: message.callerInfo ?? task.callerInfo,
          attachmentPaths: message.attachmentPaths,
          contextItems: message.context,
        });
      const resumedReviewState = reviewStateAfterFollowup(
        task.reviewState ?? "not_required",
      );
      if (userMessageEvent) {
        await persistUserMessageEvent(task, userMessageEvent, this.deps);
      }
      if (!this.deps.persistence) {
        throw new Error("running transition durable event persistence is required");
      }
      const application = await this.deps.persistence
        .enqueueRunningTransitionAndWaitForApplication(task.agentSessionId, {
          reviewState: resumedReviewState,
          transitionId: `resume:${transitionRevision}`,
          ...(expectedTerminalEventId === undefined
            ? {}
            : { expectedTerminalEventId }),
        });
      if (!application.applied) {
        applyCanonicalSessionProjection(task, application.canonicalSession);
        throw new Error(
          `auto-resume running transition rejected for ${task.agentSessionId}`,
        );
      }
      await options.afterRunningTransition?.();
      applyCanonicalSessionProjection(task, application.canonicalSession);
      if (userMessageEvent) {
        await finishUserMessageEvent(task, userMessageEvent, this.deps);
      }
      prepareTaskForAutoResume(task, message, "initializing");
      onResume(task, activation);
      return { autoResumed: true };
    } catch (error) {
      if (task.executionActivation === activation) {
        task.executionActivation = undefined;
        activation.reject(error);
      }
      if (task.status === "initializing") {
        task.status = originalStatus;
        task.terminalEventId = originalTerminalEventId;
      }
      throw error;
    }
  }

  private requireResumableProfile(task: Task): void {
    if (!this.deps.agentRegistry) return;
    if (!task.profileId) {
      throw new Error(`Cannot auto-resume ${task.agentSessionId}: task is missing profileId`);
    }
    if (task.agentProfileSnapshot) return;
    if (!this.deps.agentRegistry.get(task.profileId)) {
      throw new Error(
        `Cannot auto-resume ${task.agentSessionId}: unknown agent profile ${task.profileId}`,
      );
    }
  }

  private async awaitExecutionDrain(task: Task): Promise<void> {
    if (!task.executionPromise) return;
    try {
      await task.executionPromise;
    } catch {
      // ignore; finalize has drained.
    } finally {
      task.executionPromise = undefined;
    }
  }

  private async closeStaleEngine(task: Task): Promise<void> {
    if (!task.runner) return;
    if (task.runnerRetainedForClaudeBackground === true) return;
    const runner = task.runner;
    releaseTaskRunner(task, runner);
    try {
      await runner.dispatcher.close();
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "stale engine close failed before auto-resume",
      );
    }
  }

  private async promoteCallerInfo(
    task: Task,
    callerInfo: CallerInfo | undefined,
  ): Promise<void> {
    const entry = buildCallerInfoMetadataEntry(callerInfo);
    if (!entry) return;
    task.callerInfo = callerInfo;
    const previousCallerInfo = findLastCallerInfoMetadataEntry(task.metadata ?? []);
    if (
      previousCallerInfo !== undefined
      && stableSerialize(previousCallerInfo) === stableSerialize(entry)
    ) {
      return;
    }
    task.metadata = [...(task.metadata ?? []), entry];
    if (!this.deps.persistence) {
      this.deps.logger.warn(
        { sessionId: task.agentSessionId },
        "caller_info metadata effect unavailable — continuing auto-resume",
      );
      return;
    }
    try {
      await this.deps.persistence.enqueueMetadataEffect(task.agentSessionId, entry);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "caller_info metadata append failed — continuing auto-resume",
      );
    }
  }

}

function findLastCallerInfoMetadataEntry(
  metadata: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    const entry = metadata[index];
    if (entry?.type === "caller_info") return entry;
  }
  return undefined;
}

function stableSerialize(value: unknown): string {
  const serialized = JSON.stringify(sortJsonKeys(value));
  if (serialized === undefined) {
    throw new Error("caller_info metadata entry is not JSON serializable");
  }
  return serialized;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, sortJsonKeys(entry)]),
  );
}

function prepareTaskForAutoResume(
  task: Task,
  message: InterventionMessage,
  status: "initializing" | "running",
): void {
  task.prompt = message.text;
  task.clientId = message.user;
  if (message.callerInfo !== undefined) {
    task.callerInfo = message.callerInfo;
  }
  task.attachmentPaths = message.attachmentPaths ?? [];
  task.contextItems = message.context ?? [];
  task.status = status;
  task.reviewState = reviewStateAfterFollowup(task.reviewState ?? "not_required");
  task.completedAt = undefined;
  task.error = undefined;
  task.result = undefined;
  task.terminationReason = undefined;
  task.terminationDetail = undefined;
  task.pendingTerminationHint = undefined;
  task.pendingTerminationDetail = undefined;
  task.terminationEventRecorded = false;
  task.terminalEventId = undefined;
  enqueueInterventionOnce(task, message);
}
