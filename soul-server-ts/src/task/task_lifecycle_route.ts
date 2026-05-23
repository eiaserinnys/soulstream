import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { ExternalFinalizeParams } from "./task_lifecycle_transition.js";
import type { Task } from "./task_models.js";

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
  db: SessionDB;
  broadcaster: SessionBroadcaster;
  logger: Logger;
}

export class TaskLifecycleRoute {
  constructor(private readonly deps: TaskLifecycleRouteDeps) {}

  async cancelTask(sessionId: string): Promise<boolean> {
    return await this.deps.lifecycleTransition.cancelRunningTask(
      this.deps.getTask(sessionId),
    );
  }

  async deleteTask(sessionId: string): Promise<void> {
    const task = this.deps.getTask(sessionId);
    if (!task) return;

    await this.deps.lifecycleTransition.interruptAndDrain(task);
    this.deps.forgetTask(sessionId);

    try {
      await this.deps.db.deleteSession(sessionId);
    } catch (err) {
      this.deps.logger.warn({ err, sessionId }, "DB deleteSession failed");
    }

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
      if (task.status === "running") {
        await this.deps.lifecycleTransition.markRunningTaskInterruptedForShutdown(
          task,
          shutdownAt,
        );
      }
      const hadEngine = Boolean(task.engine);
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
