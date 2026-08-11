import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";

import type { CallerInfo, InterventionMessage, Task } from "./task_models.js";
import { enqueueInterventionOnce } from "./task_intervention_queue.js";
import { buildCallerInfoMetadataEntry } from "./task_metadata.js";
import { reviewStateAfterFollowup } from "./session_review.js";
import {
  buildUserMessageEvent,
  finishUserMessageEvent,
  persistUserMessageEvent,
  runningTransitionEffect,
} from "./task_user_message_events.js";

export type AutoResumeCallback = (task: Task) => void;

export interface AutoResumeTransitionDeps {
  logger: Logger;
  persistence?: EventPersistence;
  contextBuilder?: ExecutionContextBuilder;
  agentRegistry?: AgentRegistry;
}

/**
 * Terminal task auto-resume transition.
 *
 * Owns the ordered side effects that turn a completed/error/interrupted task
 * back into a running task for the next user turn:
 * resume capability validation -> caller metadata promotion -> user_message
 * persistence with a durable running effect -> task state transition ->
 * user_message broadcast -> executor resume callback. Orch projects the
 * running status from the durable effect, so a closed host WebSocket cannot
 * lose the transition.
 */
export class AutoResumeTransition {
  constructor(private readonly deps: AutoResumeTransitionDeps) {}

  async resume(
    task: Task,
    message: InterventionMessage,
    onResume: AutoResumeCallback,
    options: { publishUserMessage?: boolean } = {},
  ): Promise<{ autoResumed: true }> {
    this.requireResumableProfile(task);
    const transitionRevision = task.lastEventId;
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
      await persistUserMessageEvent(
        task,
        userMessageEvent,
        this.deps,
        runningTransitionEffect(resumedReviewState),
      );
    } else {
      if (!this.deps.persistence) {
        throw new Error("running transition durable event persistence is required");
      }
      await this.deps.persistence.enqueueRunningTransitionAndWaitForAck(
        task.agentSessionId,
        {
          reviewState: resumedReviewState,
          transitionId: `resume:${transitionRevision}`,
        },
      );
    }
    transitionTaskToRunning(task, message);
    if (userMessageEvent) {
      await finishUserMessageEvent(task, userMessageEvent, this.deps);
    }
    onResume(task);
    return { autoResumed: true };
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
    const runner = task.runner;
    task.runner = undefined;
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

function transitionTaskToRunning(task: Task, message: InterventionMessage): void {
  task.prompt = message.text;
  task.clientId = message.user;
  if (message.callerInfo !== undefined) {
    task.callerInfo = message.callerInfo;
  }
  task.attachmentPaths = message.attachmentPaths ?? [];
  task.contextItems = message.context ?? [];
  task.status = "running";
  task.reviewState = reviewStateAfterFollowup(task.reviewState ?? "not_required");
  task.completedAt = undefined;
  task.error = undefined;
  task.result = undefined;
  task.terminationReason = undefined;
  task.terminationDetail = undefined;
  task.pendingTerminationHint = undefined;
  task.pendingTerminationDetail = undefined;
  task.terminationEventRecorded = false;
  enqueueInterventionOnce(task, message);
}
