import type { Logger } from "pino";

import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { SessionMutationHost } from "../control_plane/persistence_host_clients.js";

import type { ExternalFinalizeParams } from "./task_lifecycle_transition.js";
import { isActiveTaskStatus, type Task } from "./task_models.js";
import type { ClaudeRuntimeRegistryCloseReason } from
  "../engine/claude_session_client_registry.js";

export interface FinalizeTaskParams extends ExternalFinalizeParams {
  agentSessionId: string;
}

export interface TaskLifecycleTransitionPort {
  cancelRunningTask(task: Task | undefined): Promise<boolean>;
  interruptAndDrain(task: Task): Promise<void>;
  markRunningTaskInterruptedForShutdown(
    task: Task,
    shutdownAt: Date,
  ): Promise<void>;
  interruptForShutdown(task: Task): Promise<void>;
  getDrainPromise(task: Task): Promise<void> | undefined;
  finalizeExternalTask(
    task: Task,
    params: ExternalFinalizeParams,
  ): Promise<Task>;
}

interface TaskLifecycleRouteDeps {
  getTask(sessionId: string): Task | undefined;
  listTasks(): Task[];
  forgetTask(sessionId: string): void;
  lifecycleTransition: TaskLifecycleTransitionPort;
  sessionMutations: SessionMutationHost;
  broadcaster: SessionBroadcaster;
  logger: Logger;
  closeSessionRuntime?: (
    sessionId: string,
    reason: ClaudeRuntimeRegistryCloseReason,
  ) => Promise<boolean>;
}

export class TaskLifecycleRoute {
  constructor(private readonly deps: TaskLifecycleRouteDeps) {}

  async cancelTask(sessionId: string): Promise<boolean> {
    const task = this.deps.getTask(sessionId);
    const cancelled = await this.deps.lifecycleTransition.cancelRunningTask(task);
    if (cancelled || !task || isActiveTaskStatus(task.status)) return cancelled;
    if (!this.deps.closeSessionRuntime) return false;
    return await this.deps.closeSessionRuntime(sessionId, "explicit_cancel");
  }

  async deleteTask(sessionId: string): Promise<void> {
    const task = this.deps.getTask(sessionId);
    if (!task) return;

    await this.deps.lifecycleTransition.interruptAndDrain(task);
    if (this.deps.closeSessionRuntime) {
      try {
        await this.deps.closeSessionRuntime(sessionId, "session_delete");
      } catch (err) {
        this.deps.logger.warn({ err, sessionId }, "session runtime close failed");
      }
    }
    await this.deps.sessionMutations.deleteSession(
      sessionId,
      `delete_session:${sessionId}`,
    );
    this.deps.forgetTask(sessionId);

    try {
      await this.deps.broadcaster.emitSessionDeleted(sessionId);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId },
        "session_deleted broadcast failed",
      );
    }
  }

  async shutdown(): Promise<void> {
    const drains: Promise<void>[] = [];
    const shutdownAt = new Date();
    for (const task of this.deps.listTasks()) {
      if (task.runner?.eventPersistence === "runner") {
        await task.runner.dispatcher.detachHost();
        task.runner = undefined;
        task.runnerRetainedForClaudeBackground = undefined;
        task.executionPromise = undefined;
        continue;
      }
      if (isActiveTaskStatus(task.status)) {
        await this.deps.lifecycleTransition.markRunningTaskInterruptedForShutdown(
          task,
          shutdownAt,
        );
      }
      const hadEngine = Boolean(task.runner);
      await this.deps.lifecycleTransition.interruptForShutdown(task);
      const drain = hadEngine
        ? this.deps.lifecycleTransition.getDrainPromise(task)
        : undefined;
      if (drain) {
        drains.push(drain);
      }
    }
    await Promise.all(drains);
  }

  async finalizeTask(params: FinalizeTaskParams): Promise<Task | undefined> {
    if (params.result === undefined && params.error === undefined) {
      throw new Error("finalizeTask requires either result or error");
    }

    const task = this.deps.getTask(params.agentSessionId);
    if (!task) {
      this.deps.logger.warn(
        { sessionId: params.agentSessionId },
        "Task not found for finalizeTask",
      );
      return undefined;
    }

    const { agentSessionId: _agentSessionId, ...finalizeParams } = params;
    return await this.deps.lifecycleTransition.finalizeExternalTask(
      task,
      finalizeParams,
    );
  }
}
