import type { Logger } from "pino";

import type {
  CodexDetachedCommandRuntimeActivity,
  SupportsCodexDetachedCommandRuntime,
  SupportsDetachedClaudeRuntime,
} from "../engine/protocol.js";

import type { CompletionNotifier } from "./completion_notifier.js";
import type { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import {
  isTerminalTaskStatus,
  type RunnerReleaseClaim,
  type Task,
} from "./task_models.js";
import {
  completeTaskRunnerReleaseClaim,
  releaseTaskRunner,
} from "./task_runner_release.js";

interface TaskExecutorFinalizerDeps {
  lifecycleTransition: Pick<TaskLifecycleTransition, "persistExecutorFinalState">;
  logger: Logger;
  completionNotifier?: CompletionNotifier;
}

export type RetainedRunnerReleaseResult =
  | "not_released"
  | "released"
  | "retry_required";

type DetachedWorkRetention = "retained" | "codex_inactive" | "not_retained";
type CodexActivityDisposition = "retain" | "inactive" | "unsupported";

export class TaskExecutorFinalizer {
  constructor(private readonly deps: TaskExecutorFinalizerDeps) {}

  async finalize(
    task: Task,
    consumeSuccessfulDeliveries?: () => Promise<void>,
  ): Promise<void> {
    const persistence = await this.deps.lifecycleTransition.persistExecutorFinalState(task, true);
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
    if (persistence.terminalTransitionApplied) {
      await this.notifyCompletion(task);
    }
  }

  async releaseRetainedClaudeRunner(task: Task): Promise<void> {
    const runner = task.runner;
    if (task.runnerRetainedForDetachedWork !== true || !runner) return;
    if (await this.shouldRetainClaudeRuntime(task, runner.engine)) return;
    if (task.runnerRetainedForDetachedWork !== true) return;

    if (!releaseTaskRunner(task, runner)) return;
    await this.closeRunnerDispatcher(task, runner);
  }

  async retainRunnerIfDetachedWorkActive(
    task: Task,
    runner: NonNullable<Task["runner"]>,
  ): Promise<DetachedWorkRetention> {
    if (task.runnerIsOfflineReplay === true) return "not_retained";
    const retention = await this.detachedWorkRetention(task, runner.engine);
    if (task.runner !== runner) return "not_retained";
    if (retention === "retained" || retention === "codex_inactive") {
      task.runnerRetainedForDetachedWork = true;
    }
    return retention;
  }

  async releaseExpiredRetainedRunner(
    task: Task,
    registrationId: string,
    recordedTerminal: boolean,
  ): Promise<RetainedRunnerReleaseResult> {
    const existingClaim = task.runnerReleaseClaim;
    if (existingClaim) {
      return task.runner === existingClaim.runner
        && existingClaim.registrationId === registrationId
        ? "retry_required"
        : "not_released";
    }
    const runner = task.runner;
    if (!runner || task.runnerRetainedForDetachedWork !== true) {
      return "not_released";
    }
    if (runner.dispatcher.registrationId() !== registrationId) {
      return "not_released";
    }
    if (await this.codexActivityDisposition(task, runner.engine) !== "inactive") {
      return "not_released";
    }

    // This post-query proof and claim installation are intentionally one
    // synchronous section. Foreground admission installs its activation before
    // yielding, so exactly one side can own the runner after the query returns.
    if (
      !recordedTerminal
      || !hasRecordedTerminal(task)
      || task.runner !== runner
      || task.runnerRetainedForDetachedWork !== true
      || runner.dispatcher.registrationId() !== registrationId
      || task.runnerReleaseClaim !== undefined
      || task.executionActivation !== undefined
      || task.executionPromise !== undefined
      || runner.dispatcher.activeExecutionCommandId?.() !== undefined
      || runner.dispatcher.hasActiveExecution() === true
    ) {
      return "not_released";
    }
    const claim = createRunnerReleaseClaim(runner, registrationId);
    task.runnerReleaseClaim = claim;

    try {
      await runner.dispatcher.close();
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, registrationId },
        "expired retained runner close failed; exact termination retry required",
      );
      return "retry_required";
    }
    return "released";
  }

  completeRetainedRunnerReleaseAfterTermination(
    task: Task,
    registrationId: string,
  ): boolean {
    const claim = task.runnerReleaseClaim;
    if (!claim || claim.registrationId !== registrationId) return false;
    return this.completeRunnerReleaseClaim(task, claim);
  }

  private async closeEngine(task: Task): Promise<void> {
    const runner = task.runner;
    // An offline replay handle has no live child to keep background work in,
    // so retaining it only strands `task.runner` and blocks every later turn.
    if (
      runner
      && await this.retainRunnerIfDetachedWorkActive(task, runner) === "retained"
    ) return;
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
      if (activity === null) {
        this.deps.logger.warn(
          { sessionId: task.agentSessionId },
          "detached Claude runtime activity unsupported; retaining runner owner",
        );
        return true;
      }
      return activity.backgroundTaskCount > 0 ||
        (activity.pendingRuntimeSignalCount ?? 0) > 0;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "detached Claude runtime activity failed; retaining runner owner",
      );
      return true;
    }
  }

  private async detachedWorkRetention(
    task: Task,
    engine: NonNullable<Task["runner"]>["engine"],
  ): Promise<DetachedWorkRetention> {
    const claude = engine as typeof engine & Partial<SupportsDetachedClaudeRuntime>;
    if (claude.detachedClaudeRuntime === true) {
      return await this.shouldRetainClaudeRuntime(task, engine)
        ? "retained"
        : "not_retained";
    }
    const codex = await this.codexActivityDisposition(task, engine);
    if (codex === "retain") return "retained";
    if (codex === "inactive") return "codex_inactive";
    return "not_retained";
  }

  private async codexActivityDisposition(
    task: Task,
    engine: NonNullable<Task["runner"]>["engine"],
  ): Promise<CodexActivityDisposition> {
    const detached = engine as typeof engine & Partial<SupportsCodexDetachedCommandRuntime>;
    if (detached.codexDetachedCommandRuntime !== true) return "unsupported";
    if (typeof detached.codexDetachedCommandActivity !== "function") {
      this.deps.logger.warn(
        { sessionId: task.agentSessionId },
        "Codex detached-command capability is invalid; retaining runner owner",
      );
      return "retain";
    }
    try {
      const activity = await detached.codexDetachedCommandActivity();
      if (activity === null) return "unsupported";
      return codexActivityIsEmpty(activity) ? "inactive" : "retain";
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "Codex detached-command activity failed; retaining runner owner",
      );
      return "retain";
    }
  }

  private completeRunnerReleaseClaim(
    task: Task,
    claim: RunnerReleaseClaim,
  ): boolean {
    return completeTaskRunnerReleaseClaim(task, claim);
  }

  private async notifyCompletion(task: Task): Promise<void> {
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

function codexActivityIsEmpty(
  activity: CodexDetachedCommandRuntimeActivity,
): boolean {
  return activity.activeForegroundCount === 0
    && activity.detachedRunningCount === 0
    && activity.retainedTerminalResultCount === 0;
}

function hasRecordedTerminal(task: Task): boolean {
  return isTerminalTaskStatus(task.status)
    && task.terminationEventRecorded === true
    && typeof task.terminalEventId === "number"
    && Number.isSafeInteger(task.terminalEventId)
    && task.terminalEventId > 0;
}

function createRunnerReleaseClaim(
  runner: NonNullable<Task["runner"]>,
  registrationId: string,
): RunnerReleaseClaim {
  let resolve!: () => void;
  const completion = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { runner, registrationId, completion, resolve };
}
