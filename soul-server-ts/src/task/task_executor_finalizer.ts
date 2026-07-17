import type { Logger } from "pino";

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
    await this.deps.lifecycleTransition.persistExecutorFinalState(task);
    await this.closeEngine(task);
    await this.notifyCompletion(task);
  }

  private async closeEngine(task: Task): Promise<void> {
    try {
      await task.engine?.close();
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "engine.close failed",
      );
    }
    task.engine = undefined;
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
