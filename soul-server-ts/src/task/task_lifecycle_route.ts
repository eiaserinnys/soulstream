import type { Logger } from "pino";

import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { SessionMutationHost } from "../control_plane/persistence_host_clients.js";

import {
  isUserStopConverged,
  type ExternalFinalizeParams,
} from "./task_lifecycle_transition.js";
import { isActiveTaskStatus, type Task } from "./task_models.js";
import { releaseTaskRunner } from "./task_runner_release.js";
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
  hasSessionRuntime?: (sessionId: string) => boolean;
}

export class TaskLifecycleRoute {
  constructor(private readonly deps: TaskLifecycleRouteDeps) {}

  async cancelTask(sessionId: string): Promise<boolean> {
    const task = this.deps.getTask(sessionId);
    const wasActive = Boolean(task && isActiveTaskStatus(task.status));
    if (isUserStopConverged(task)) {
      return await this.closeSessionRuntimeIfPresent(sessionId, "explicit_cancel");
    }
    const cancelled = await this.deps.lifecycleTransition.cancelRunningTask(task);
    if (!task || isActiveTaskStatus(task.status)) return cancelled;
    const runtimeClosed = await this.closeSessionRuntimeIfPresent(
      sessionId,
      "explicit_cancel",
    );
    if (!runtimeClosed) return false;
    if (wasActive && !cancelled) return false;
    return isUserStopConverged(task);
  }

  private async closeSessionRuntimeIfPresent(
    sessionId: string,
    reason: ClaudeRuntimeRegistryCloseReason,
  ): Promise<boolean> {
    const runtimePresent = this.deps.hasSessionRuntime?.(sessionId)
      ?? Boolean(this.deps.closeSessionRuntime);
    if (!runtimePresent) return true;
    const closeSessionRuntime = this.deps.closeSessionRuntime;
    const closed = await closeSessionRuntime?.(
      sessionId,
      reason,
    ) ?? false;
    return closed && !(this.deps.hasSessionRuntime?.(sessionId) ?? false);
  }

  async deleteTask(sessionId: string): Promise<boolean> {
    const task = this.deps.getTask(sessionId);
    if (!task) return false;

    const runner = task.runner;
    // 실행 중인 세션은 사람이 멈춘 것과 같은 경로로 멈춘다. 부른 세션 통지 등록이
    // 끝난 뒤 러너를 닫고(retire 포함) 그 다음 행을 지운다. 러너가 아직 붙지 않은
    // creation 단계 task는 멈출 실행이 없으므로 예전처럼 바로 지운다.
    if (isActiveTaskStatus(task.status) && runner) {
      await this.deps.lifecycleTransition.cancelRunningTask(task);
      if (isActiveTaskStatus(task.status)) {
        throw new Error(
          `running session stop did not converge before delete: ${sessionId}`,
        );
      }
    }
    const runtimeClosed = await this.closeSessionRuntimeIfPresent(
      sessionId,
      "session_delete",
    );
    if (!runtimeClosed) {
      throw new Error(`session runtime close did not converge: ${sessionId}`);
    }
    if (runner) {
      // cancelRunningTask가 이미 닫았으면 close는 idempotent다. 등록 retire는
      // 삭제 전에 반드시 수행한다.
      await runner.dispatcher.close();
      if (runner.eventPersistence === "runner") {
        const retire = runner.dispatcher.retireTerminalRegistration;
        if (!retire) {
          throw new Error(
            `runner terminal registration retirement is unavailable: ${sessionId}`,
          );
        }
        await retire.call(runner.dispatcher);
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
    return true;
  }

  async shutdown(): Promise<void> {
    const drains: Promise<void>[] = [];
    const shutdownAt = new Date();
    for (const task of this.deps.listTasks()) {
      if (task.runner?.eventPersistence === "runner") {
        const runner = task.runner;
        await runner.dispatcher.detachHost();
        releaseTaskRunner(task, runner);
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
