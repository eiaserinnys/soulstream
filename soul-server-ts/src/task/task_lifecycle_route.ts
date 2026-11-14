import type { Logger } from "pino";

import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { SessionMutationHost } from "../control_plane/persistence_host_clients.js";

import {
  isUserStopConverged,
  type ExternalFinalizeParams,
} from "./task_lifecycle_transition.js";
import { isActiveTaskStatus, type Task } from "./task_models.js";
import { releaseTaskRunner } from "./task_runner_release.js";
import { nodeExecutionPhaseOfTask } from "./state/node_execution_decision.js";
import type { ClaudeRuntimeRegistryCloseReason } from
  "../engine/claude_session_client_registry.js";

export interface FinalizeTaskParams extends ExternalFinalizeParams {
  agentSessionId: string;
}

export interface TaskLifecycleTransitionPort {
  cancelRunningTask(
    task: Task | undefined,
    options?: { forDelete?: boolean },
  ): Promise<boolean>;
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
  /** 지우기 전에 그 세션의 완료 정산 미결을 정산한다. 등록하지 못하면 던진다. */
  settleBeforeDelete?(task: Task): Promise<void>;
  /** 지운 세션의 완료 정산 미결을 남기지 않는다. */
  discardSettlementsAfterDelete?(sessionId: string): Promise<void>;
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
    //
    // 앞선 삭제가 멈춤 영속이나 통지 등록에서 실패하면 status는 이미 종료값으로
    // 남는다(transition.ts의 종료 투영). 그래서 status만 보면 마무리를 건너뛰고
    // 줄을 지워 버린다. 끝나지 않은 멈춤 마무리는 `interruptRequest`가 남아 있는
    // 것으로 표시하고(성공 경로에서만 지운다), 다시 지울 때도 같은 멈춤 경로로
    // 종료 영속과 이번 revision 통지 등록을 다시 시도해 확인한 뒤에만 지운다.
    //
    // 지시 넘기기 장벽은 멈춤 마무리가 아니므로 멈춤 대기로 읽지 않는다. 러너 없이
    // DB에서 올린 활성 task는 지연 로더가 만든 것이라 조용히 지우지 않고 같은 멈춤
    // 경로로 종료 기록과 통지 등록을 만든 뒤 지운다.
    const stopFinalizationPending = task.interruptRequest !== undefined
      && task.interruptBarrierKind !== "intervention_handoff";
    const runnerlessActive = isActiveTaskStatus(task.status)
      && !runner
      && nodeExecutionPhaseOfTask(task) === "hydrated_active";
    if (
      (isActiveTaskStatus(task.status) && runner)
      || runnerlessActive
      || stopFinalizationPending
    ) {
      // 삭제가 일으킨 멈춤은 종료 영속과 부른 세션 통지 등록이 확인돼야 한다.
      // 확인되지 않으면 cancelRunningTask가 throw하고, 세션 행은 남는다.
      await this.deps.lifecycleTransition.cancelRunningTask(task, {
        forDelete: true,
      });
      if (!isUserStopConverged(task)) {
        throw new Error(
          `running session stop did not converge before delete: ${sessionId}`,
        );
      }
    }
    // 이미 종료 상태라 멈춤 없이 지우는 갈래도 여기서 미결을 정산한다. 등록이나 정책상 생략을
    // 확인하지 못하면 던져 줄을 지우지 않는다(지운 뒤에는 중앙 줄이 없어 훑기가 되살릴 수 없다).
    await this.deps.lifecycleTransition.settleBeforeDelete?.(task);
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
    await this.deps.lifecycleTransition.discardSettlementsAfterDelete?.(sessionId);

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
