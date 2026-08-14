import type { Logger } from "pino";

import type { SupportsDetachedClaudeRuntime } from "../engine/protocol.js";

import type { CompletionNotifier } from "./completion_notifier.js";
import type { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import type { Task } from "./task_models.js";

interface TaskExecutorFinalizerDeps {
  lifecycleTransition: Pick<TaskLifecycleTransition, "persistExecutorFinalState">;
  logger: Logger;
  completionNotifier?: CompletionNotifier;
}

export class TaskExecutorFinalizer {
  constructor(private readonly deps: TaskExecutorFinalizerDeps) {}

  async finalize(task: Task): Promise<void> {
    const persistence = await this.deps.lifecycleTransition.persistExecutorFinalState(task);
    await this.closeEngine(task);
    if (persistence.newlyFinalized && persistence.terminalTransitionApplied) {
      await this.notifyCompletion(task);
    }
  }

  private async closeEngine(task: Task): Promise<void> {
    const runner = task.runner;
    if (runner && await this.shouldRetainClaudeRuntime(task, runner.engine)) {
      task.runnerRetainedForClaudeBackground = true;
      return;
    }
    try {
      await runner?.dispatcher.close();
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "engine.close failed",
      );
    }
    task.runner = undefined;
    task.runnerRetainedForClaudeBackground = undefined;
  }

  private async shouldRetainClaudeRuntime(
    task: Task,
    engine: NonNullable<Task["runner"]>["engine"],
  ): Promise<boolean> {
    const detached = engine as typeof engine & Partial<SupportsDetachedClaudeRuntime>;
    if (detached.detachedClaudeRuntime !== true) return false;
    if (typeof detached.detachedClaudeRuntimeActivity !== "function") {
      this.deps.logger.warn(
        { sessionId: task.agentSessionId },
        "detached Claude runtime activity unavailable; retaining runner owner",
      );
      return true;
    }
    try {
      const activity = await detached.detachedClaudeRuntimeActivity();
      return (activity?.backgroundTaskCount ?? 0) > 0;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "detached Claude runtime activity failed; retaining runner owner",
      );
      return true;
    }
  }

  private async notifyCompletion(task: Task): Promise<void> {
    if (task.pendingClaudeRuntimeFollowupRetry === true) return;
    if (!task.callerSessionId || !this.deps.completionNotifier) return;

    try {
      await this.deps.completionNotifier.notify(task);
    } catch (err) {
      // notifier is expected to isolate local/cross-node failures; this is a final safety net.
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "completionNotifier.notify threw (should not happen — notifier is supposed to isolate)",
      );
    }
  }
}
