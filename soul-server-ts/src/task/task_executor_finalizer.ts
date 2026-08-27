import type { Logger } from "pino";

import type { SupportsDetachedClaudeRuntime } from "../engine/protocol.js";

import type { CompletionNotifier } from "./completion_notifier.js";
import type { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import type { Task } from "./task_models.js";
import { releaseTaskRunner } from "./task_runner_release.js";

interface TaskExecutorFinalizerDeps {
  lifecycleTransition: Pick<TaskLifecycleTransition, "persistExecutorFinalState">;
  logger: Logger;
  completionNotifier?: CompletionNotifier;
}

export class TaskExecutorFinalizer {
  constructor(private readonly deps: TaskExecutorFinalizerDeps) {}

  async finalize(
    task: Task,
    consumeSuccessfulDeliveries?: () => Promise<void>,
  ): Promise<void> {
    const persistence = await this.deps.lifecycleTransition.persistExecutorFinalState(task);
    // The sessions-row release ACK is the durable terminal/owner boundary. Keep
    // the runner handle until it commits so the same owner can retry on failure.
    await this.closeEngine(task);
    if (
      persistence.terminalTransitionApplied
      && task.status === "completed"
      && consumeSuccessfulDeliveries
    ) {
      await consumeSuccessfulDeliveries();
    }
    if (persistence.newlyFinalized && persistence.terminalTransitionApplied) {
      await this.notifyCompletion(task);
    }
  }

  async releaseRetainedClaudeRunner(task: Task): Promise<void> {
    const runner = task.runner;
    if (task.runnerRetainedForClaudeBackground !== true || !runner) return;
    if (await this.shouldRetainClaudeRuntime(task, runner.engine)) return;
    if (task.runnerRetainedForClaudeBackground !== true) return;

    if (!releaseTaskRunner(task, runner)) return;
    await this.closeRunnerDispatcher(task, runner);
  }

  private async closeEngine(task: Task): Promise<void> {
    const runner = task.runner;
    // An offline replay handle has no live child to keep background work in,
    // so retaining it only strands `task.runner` and blocks every later turn.
    if (
      runner
      && task.runnerIsOfflineReplay !== true
      && await this.shouldRetainClaudeRuntime(task, runner.engine)
    ) {
      task.runnerRetainedForClaudeBackground = true;
      return;
    }
    if (runner) await this.closeRunnerDispatcher(task, runner);
    if (runner) releaseTaskRunner(task, runner);
  }

  private async closeRunnerDispatcher(
    task: Task,
    runner: NonNullable<Task["runner"]>,
  ): Promise<void> {
    try {
      await runner.dispatcher.close();
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "engine.close failed",
      );
    }
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
