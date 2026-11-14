import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";

import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  terminalTaskStatusForReason,
  type Task,
} from "./task_models.js";
import {
  runnerFactProjection,
  type RunnerTerminalFact,
} from "./execution_registration.js";
import { reviewStateAfterTerminal } from "./session_review.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import {
  buildSessionEndedEvent,
  finalizeTaskTermination,
  recordTerminationHint,
} from "./task_termination.js";
import { releaseTaskRunner } from "./task_runner_release.js";
import { decideNodeStopRequest } from "./state/node_barrier_decision.js";
import { nodeExecutionPhaseOfTask } from "./state/node_execution_decision.js";
import {
  judgeNodeResponse,
  nodeResponseFactsFromApplication,
  nodeResponseFactsFromError,
  type NodeResponseContext,
  type NodeResponseVerdict,
} from "./state/node_response_handling.js";

export interface ExternalFinalizeParams {
  result?: string;
  error?: string;
  llmUsage?: Record<string, number> | null;
}

/**
 * 완료 통지 포트. `notifyForDelete`는 삭제 길 전용으로, 이번 종료 revision의
 * 등록 결과를 실제로 돌려준다. 구현이 없으면 삭제 경로는 등록을 확인할 수
 * 없으므로 삭제를 멈춘다(등록 없이 세션 행을 지우지 않는다).
 */
interface CompletionNotificationPort {
  notify(task: Task): Promise<void>;
  notifyForDelete?(task: Task): Promise<boolean>;
  notifyBackgroundStopped?(task: Task, firstSentence: string): Promise<void>;
}

/** 종료 응답의 정리 의도를 실행하는 포트다. 모두 없을 수 있다. */
export interface TerminationCleanupPorts {
  /**
   * 완료 정산 미결 닫기의 호출점이다. 기본 구현은 아무것도 하지 않는다.
   * 미결의 영속과 닫기는 다음 단위(카드 #1266 I3)가 채운다.
   */
  closeSettlementPending?: (
    task: Task,
    info: { registrationId: string | null },
  ) => Promise<void>;
  /** 중앙 세션이 없을 때 로컬 소유를 정리한다. 없으면 러너와 등록을 놓고 task를 잊는다. */
  releaseLocalOwnership?: (task: Task) => Promise<void>;
  /** 중앙 세션 한 줄을 캐시 없이 읽는다. 없으면 중앙 세션 유무를 확인하지 않는다. */
  readCentralSession?: (sessionId: string) => Promise<unknown | null>;
  /** 메모리의 task를 잊는다. */
  forgetTask?: (sessionId: string) => void;
  /**
   * 거절된 종료의 러너 등록을 디스크에서 은퇴시킨다. 은퇴는 거절을 받은 때 남아야
   * 재시작 뒤 복구가 같은 종료를 다시 올리지 않는다. 러너 복구가 잇는다.
   */
  retireRejectedRegistration?: (task: Task, registrationId: string) => Promise<void>;
}

interface TaskLifecycleTransitionDeps extends TerminationCleanupPorts {
  logger: Logger;
  persistence?: EventPersistence;
  completionNotifier?: CompletionNotificationPort;
}

export interface TaskFinalStatePersistenceResult {
  newlyFinalized: boolean;
  terminalTransitionApplied: boolean;
}

export const USER_STOP_PROJECTION = {
  true: {
    status: terminalTaskStatusForReason("killed"),
    error: undefined,
    terminationReason: "killed",
    terminationDetail: "user_stop",
  },
  false: {
    status: terminalTaskStatusForReason("error_aborted"),
    error: "runner stop was not confirmed",
    terminationReason: "error_aborted",
    terminationDetail: "runner stop was not confirmed",
  },
} as const;

/** A repeated user stop succeeds only after every execution projection converged. */
export function isUserStopConverged(task: Task | undefined): boolean {
  return Boolean(
    task
    && isTerminalTaskStatus(task.status)
    && !task.executionRegistration
    && !task.runner
    && !task.executionPromise,
  );
}

export class TaskLifecycleTransition {
  private completionNotifier?: CompletionNotificationPort;
  private ports: TerminationCleanupPorts;

  constructor(private readonly deps: TaskLifecycleTransitionDeps) {
    this.completionNotifier = deps.completionNotifier;
    this.ports = {
      closeSettlementPending: deps.closeSettlementPending,
      releaseLocalOwnership: deps.releaseLocalOwnership,
      readCentralSession: deps.readCentralSession,
      forgetTask: deps.forgetTask,
      retireRejectedRegistration: deps.retireRejectedRegistration,
    };
  }

  setCompletionNotifier(completionNotifier: CompletionNotificationPort): void {
    this.completionNotifier = completionNotifier;
  }

  /**
   * 종료 정리 포트를 나중에 잇는다. 완료 정산 미결 닫기는 다음 단위(카드 #1266 I3)가
   * 영속 구현으로 여기에 잇는다.
   */
  setCleanupPorts(ports: TerminationCleanupPorts): void {
    this.ports = { ...this.ports, ...ports };
  }

  /**
   * `persistence.terminalTransitionApplied`는 이번 호출이 종료 전이를 적용했는지만
   * 말한다. 삭제 길은 재시도로 들어올 수 있으므로 그 값과 무관하게 이번 종료
   * revision의 통지 등록을 다시 확인한다(`requireRegistration`).
   */
  async notifyCompletionIfApplied(
    task: Task,
    persistence: TaskFinalStatePersistenceResult,
    options: { requireRegistration?: boolean } = {},
  ): Promise<boolean> {
    const requireRegistration = options.requireRegistration === true;
    if (!requireRegistration && !persistence.terminalTransitionApplied) {
      return true;
    }
    if (!task.callerSessionId || !this.completionNotifier) return true;

    try {
      if (requireRegistration) {
        const notifyForDelete = this.completionNotifier.notifyForDelete;
        if (!notifyForDelete) {
          this.deps.logger.warn(
            { sessionId: task.agentSessionId },
            "completion notifier cannot confirm registration before delete",
          );
          return false;
        }
        return await notifyForDelete.call(this.completionNotifier, task);
      }
      await this.completionNotifier.notify(task);
      return true;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "completion notification failed after terminal transition was applied",
      );
      return false;
    }
  }

  /**
   * 보유가 followup 없이 풀렸다는 알림(R3). 부른 세션이 없으면 보내지 않는다.
   * 알림 실패는 턴 종료를 막지 않는다.
   */
  async notifyBackgroundStopped(task: Task, firstSentence: string): Promise<boolean> {
    const notify = this.completionNotifier?.notifyBackgroundStopped;
    if (!task.callerSessionId || !notify) return true;
    try {
      await notify.call(this.completionNotifier, task, firstSentence);
      return true;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "background retention stop notification failed",
      );
      return false;
    }
  }

  async cancelRunningTask(
    task: Task | undefined,
    options: { forDelete?: boolean } = {},
  ): Promise<boolean> {
    const forDelete = options.forDelete === true;
    if (!task) return false;
    if (isUserStopConverged(task)) {
      task.interruptRequest = undefined;
      task.interruptBarrierKind = undefined;
      return true;
    }
    if (task.interruptRequest) {
      const previousRequest = task.interruptRequest;
      // 장벽 직렬화 정본: 지시 넘기기 장벽을 만난 멈춤은 넘기기가 끝난 뒤 보통
      // 멈춤 길로 간다. 멈춤 장벽이면 이미 멈추는 중이라 그 결과에 붙는다.
      const disposition = decideNodeStopRequest(
        task.interruptBarrierKind === "intervention_handoff"
          ? "intervention_handoff"
          : "stop",
      );
      if (disposition === "stop_after_handoff") {
        await previousRequest.catch(() => false);
        return await this.cancelRunningTask(task, options);
      }
      await previousRequest.catch(() => false);
      if (isUserStopConverged(task)) {
        task.interruptRequest = undefined;
        task.interruptBarrierKind = undefined;
        return true;
      }
      if (task.interruptRequest !== previousRequest) {
        return await task.interruptRequest;
      }
      const retry = this.retryUserStopFinalization(task, forDelete);
      task.interruptRequest = retry;
      task.interruptBarrierKind = "stop";
      return await retry;
    }
    if (!isActiveTaskStatus(task.status)) return false;
    if (!task.runner) {
      // 러너 없이 DB에서 올린 활성 task는 멈출 실행이 없어도 종료 기록을 만든다
      // (SESSION_NOT_RUNNING으로 돌려보내면 세션이 영구 running으로 남는다).
      if (nodeExecutionPhaseOfTask(task) !== "hydrated_active") return false;
      const stopWithoutRunner = this.finalizeUserStop(
        task,
        undefined,
        undefined,
        true,
        forDelete,
      );
      task.interruptRequest = stopWithoutRunner;
      task.interruptBarrierKind = "stop";
      return await stopWithoutRunner;
    }

    const runner = task.runner;
    const executionPromise = task.executionPromise;
    const request = (async (): Promise<boolean> => {
      let interrupted = false;
      try {
        interrupted = await runner.dispatcher.interrupt();
      } catch (err) {
        this.deps.logger.warn(
          { err, sessionId: task.agentSessionId },
          "Runner interrupt delivery failed; fencing task as stop_failed",
        );
      }
      return await this.finalizeUserStop(
        task,
        runner,
        executionPromise,
        interrupted,
        forDelete,
      );
    })();
    task.interruptRequest = request;
    task.interruptBarrierKind = "stop";
    return await request;
  }

  private retryUserStopFinalization(
    task: Task,
    forDelete: boolean,
  ): Promise<boolean> {
    return this.finalizeUserStop(
      task,
      task.runner,
      task.executionPromise,
      task.pendingTerminationHint === "killed",
      forDelete,
    );
  }

  private async finalizeUserStop(
    task: Task,
    runner: Task["runner"],
    executionPromise: Promise<void> | undefined,
    interrupted: boolean,
    forDelete: boolean,
  ): Promise<boolean> {
    if (isActiveTaskStatus(task.status)) {
      const projection = USER_STOP_PROJECTION[String(interrupted) as "true" | "false"];
      task.status = projection.status;
      task.completedAt ??= new Date();
      task.error = projection.error;
      recordTerminationHint(
        task,
        projection.terminationReason,
        projection.terminationDetail,
      );
    }

    const stopCompletedAt = task.completedAt ?? new Date();
    task.completedAt = stopCompletedAt;
    let persistence: TaskFinalStatePersistenceResult;
    try {
      persistence = await this.persistFinalState(task, true);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "Explicit stop terminal persistence failed; awaiting explicit retry",
      );
      if (forDelete) {
        throw new Error(
          `user stop terminal persistence failed before delete: ${task.agentSessionId}`,
          { cause: err },
        );
      }
      return false;
    }
    if (!isTerminalTaskStatus(task.status)) {
      task.completedAt = stopCompletedAt;
      if (forDelete) {
        throw new Error(
          `user stop did not reach a terminal status before delete: ${task.agentSessionId}`,
        );
      }
      return false;
    }
    // 삭제가 일으킨 멈춤은 종료 사건이 실제로 기록됐을 때만 줄을 지운다. status만
    // 보고 넘어가면 영속이 유실된 세션 행을 지워 버린다.
    if (forDelete && task.terminationEventRecorded !== true) {
      throw new Error(
        `user stop terminal event was not recorded before delete: ${task.agentSessionId}`,
      );
    }

    // 디렉터 결정(261112): 멈춤 버튼도 부른 세션에 알린다. 통지 등록이 끝난 뒤에
    // 러너를 닫아야 삭제 경로가 등록을 잃지 않는다.
    const notified = await this.notifyCompletionIfApplied(task, persistence, {
      requireRegistration: forDelete,
    });
    if (forDelete && !notified) {
      throw new Error(
        `completion notification registration failed before delete: ${task.agentSessionId}`,
      );
    }

    if (runner) {
      try {
        await runner.dispatcher.close();
      } catch (err) {
        this.deps.logger.warn(
          { err, sessionId: task.agentSessionId },
          "runner close failed after explicit stop was fenced",
        );
      }
      releaseTaskRunner(task, runner);
    }
    if (task.executionPromise === executionPromise) {
      task.executionPromise = undefined;
    }
    task.interruptRequest = undefined;
    task.interruptBarrierKind = undefined;
    return interrupted;
  }

  async interruptAndDrain(task: Task): Promise<void> {
    if (!task.runner) return;

    try {
      await task.runner.dispatcher.interrupt();
    } catch {
      // interrupt is idempotent; cleanup must continue.
    }
    if (task.executionPromise) {
      try {
        await task.executionPromise;
      } catch {
        // interrupted execution rejection must not block cleanup.
      }
    }
  }

  async markRunningTaskInterruptedForShutdown(
    task: Task,
    shutdownAt: Date,
  ): Promise<void> {
    if (!isActiveTaskStatus(task.status)) return;

    task.status = "interrupted";
    task.completedAt = shutdownAt;
    recordTerminationHint(task, "killed", "shutdown");
    await this.persistFinalState(task);
  }

  async interruptForShutdown(task: Task): Promise<void> {
    if (!task.runner) return;

    try {
      await task.runner.dispatcher.interrupt();
    } catch {
      // idempotent; shutdown drain collection must continue.
    }
  }

  getDrainPromise(task: Task): Promise<void> | undefined {
    return task.executionPromise?.catch(() => undefined);
  }

  async finalizeExternalTask(
    task: Task,
    params: ExternalFinalizeParams,
  ): Promise<Task> {
    if (params.result !== undefined) {
      task.status = "completed";
      task.result = params.result;
      task.error = undefined;
    } else {
      task.status = "error";
      task.error = params.error;
      task.result = undefined;
    }
    task.completedAt = new Date();
    if (params.llmUsage !== undefined) {
      task.llmUsage = params.llmUsage;
    }

    await this.persistFinalState(task);
    return task;
  }

  async persistExecutorFinalState(
    task: Task,
    retryUnrecordedTerminal = false,
  ): Promise<TaskFinalStatePersistenceResult> {
    return await this.persistFinalState(task, retryUnrecordedTerminal);
  }

  applyRunnerTerminalFact(
    task: Task,
    runnerFact: RunnerTerminalFact,
    terminationDetail: string | null,
  ): void {
    if (!isTerminalTaskStatus(task.status)) {
      const projection = runnerFactProjection(runnerFact);
      task.status = projection.status;
      task.completedAt = new Date();
      task.reviewState = reviewStateAfterTerminal(task.reviewRequired === true);
      task.terminationReason = projection.terminationReason;
      task.terminationDetail = terminationDetail;
      task.pendingTerminationHint = undefined;
      task.pendingTerminationDetail = undefined;
    }
    task.runnerTerminalFact = runnerFact;
  }

  private async persistFinalState(
    task: Task,
    retryUnrecordedTerminal = false,
  ): Promise<TaskFinalStatePersistenceResult> {
    const termination = finalizeTaskTermination(task);
    if (termination.newlyFinalized) {
      task.reviewState = reviewStateAfterTerminal(task.reviewRequired === true);
    }
    let terminalTransitionApplied = false;
    if (
      !terminalTransitionApplied
      && (termination.newlyFinalized || retryUnrecordedTerminal)
      && isTerminalTaskStatus(task.status)
      && !task.terminationEventRecorded
    ) {
      terminalTransitionApplied = await this.enqueueAndAwaitSessionEnded(
        task,
        termination.reason,
        termination.detail,
      );
    }
    return {
      newlyFinalized: termination.newlyFinalized,
      terminalTransitionApplied,
    };
  }

  private async enqueueAndAwaitSessionEnded(
    task: Task,
    terminationReason: string,
    terminationDetail: string | null,
  ): Promise<boolean> {
    if (!this.deps.persistence) {
      throw new Error("session_ended durable event persistence is required");
    }
    const event = buildSessionEndedEvent(task);
    const common = {
      termination_detail: terminationDetail,
      review_state: task.reviewState ?? "not_required",
      last_assistant_text: task.lastAssistantText ?? null,
      updated_at: (task.completedAt ?? new Date()).toISOString(),
    };
    const effect = {
      kind: "terminal_transition" as const,
      status: task.status,
      termination_reason: terminationReason,
      ...common,
    };
    const registrationId = task.executionRegistration?.registrationId;
    const context: NodeResponseContext = {
      call: "termination",
      registrationId: registrationId ?? null,
      retained: task.runnerRetainedForDetachedWork === true,
    };
    let application: Awaited<
      ReturnType<EventPersistence["enqueueTerminalTransitionAndWaitForApplication"]>
    >;
    try {
      application = registrationId === undefined
        ? await this.deps.persistence.enqueueTerminalTransitionAndWaitForApplication(
            task.agentSessionId,
            event,
            effect,
          )
        : await this.deps.persistence.enqueueTerminalTransitionAndWaitForApplication(
            task.agentSessionId,
            event,
            effect,
            registrationId,
          );
    } catch (error) {
      const facts = nodeResponseFactsFromError(context, error);
      // 응답이 아닌 오류와 응답 없음은 다시 올릴 수 있으므로 그대로 던진다.
      if (!facts || facts.route === "no_response") throw error;
      await this.settleRejection(task, judgeNodeResponse(facts), this.rejectedRegistrationOf(task, registrationId));
      return false;
    }
    applyCanonicalSessionProjection(task, application.canonicalSession);
    if (
      isTerminalTaskStatus(task.status)
      && application.canonicalExecutionRegistration == null
    ) {
      task.executionRegistration = undefined;
    }
    if (application.applied) return true;
    const verdict = judgeNodeResponse(
      nodeResponseFactsFromApplication(context, application),
    );
    if (verdict.decision.cell === "applied") return true;
    await this.settleRejection(task, verdict, this.rejectedRegistrationOf(task, registrationId));
    return false;
  }

  /** 거절된 종료의 러너 등록이다. 복구 중이면 복구하는 등록, 아니면 이 실행의 등록이다. */
  private rejectedRegistrationOf(task: Task, executionRegistrationId: string | undefined): string | null {
    return task.runnerRecoveryRegistrationId ?? executionRegistrationId ?? null;
  }

  private async probeCentralSession(
    sessionId: string,
  ): Promise<"present" | "absent" | "unknown"> {
    const read = this.ports.readCentralSession;
    if (!read) return "unknown";
    try {
      return (await read(sessionId)) === null ? "absent" : "present";
    } catch (error) {
      this.deps.logger.warn(
        { err: error, sessionId },
        "central session lookup failed while settling a rejected terminal",
      );
      return "unknown";
    }
  }

  /**
   * 거절 응답이 고른 정리 의도를 실행하고 최종 판정을 돌려준다. 중앙 세션 유무를 모르면
   * 먼저 확인해 다시 판정한다. 같은 종료를 다시 올리는 의도는 실행할 것이 없다(주기 훑기가
   * 다시 올리는 것은 등록 은퇴가 막는다). 중앙 오류 표시는 여기서 실행하지 않는다: 덮는
   * 길이 호출마다 다르므로 돌려준 판정을 보고 호출자가 한다(실행 등록과 첫 메시지는
   * 실행기의 오류 종료, 잇기는 실행기의 settleAdoptRejection, 재개는 재개 전이의 거절을 받은 쪽).
   * 정리 하나가 실패해도 다음 정리와 마무리를 막지 않는다.
   */
  async settleRejection(
    task: Task,
    verdict: NodeResponseVerdict,
    registrationId: string | null,
  ): Promise<NodeResponseVerdict> {
    verdict = await this.judgeWithCentralSession(task, verdict);
    for (const intent of verdict.decision.intents) {
      try {
        if (intent === "close_settlement_pending") {
          await this.ports.closeSettlementPending?.(task, { registrationId });
        } else if (intent === "retire_rejected_registration") {
          if (registrationId !== null) {
            // 표시는 은퇴가 끝나기 전의 대비다. 은퇴가 못 끝나면 러너 복구가 다음 훑기에서 마저 한다.
            task.rejectedTerminationRegistrationId = registrationId;
            // 러너가 붙어 있으면 마무리가 러너를 닫거나 보유할지 정한 뒤에 한다(retireRejectedTerminal).
            if (!task.runner) await this.retireRejectedTerminal(task);
          }
        } else if (intent === "release_local_ownership") {
          await this.releaseLocalOwnershipThroughPorts(task);
        }
      } catch (error) {
        this.deps.logger.warn(
          { err: error, sessionId: task.agentSessionId, intent },
          "rejected response cleanup step failed",
        );
      }
    }
    this.deps.logger.info(
      {
        sessionId: task.agentSessionId,
        cell: verdict.decision.cell,
        intents: verdict.decision.intents,
      },
      "node response was rejected",
    );
    return verdict;
  }

  /**
   * 거절된 종료가 남긴 표시의 그 등록만 디스크에서 은퇴시킨다. 정상 보유 중인 러너는
   * 거두지 않는다. 실패하면 표시가 남아 러너 복구가 다시 시도한다.
   */
  async retireRejectedTerminal(task: Task): Promise<void> {
    const registrationId = task.rejectedTerminationRegistrationId;
    if (registrationId === undefined) return;
    if (task.runnerRetainedForDetachedWork === true) return;
    const retire = this.ports.retireRejectedRegistration;
    if (!retire) return;
    try {
      await retire(task, registrationId);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, sessionId: task.agentSessionId, registrationId },
        "rejected terminal registration retirement failed; recovery retries it",
      );
    }
  }

  /** 중앙 세션 유무를 모르는 판정이면 확인해 다시 판정한다. 확인하지 못하면 그대로 둔다. */
  async judgeWithCentralSession(
    task: Task,
    verdict: NodeResponseVerdict,
  ): Promise<NodeResponseVerdict> {
    if (verdict.facts.centralSession !== "unknown") return verdict;
    const centralSession = await this.probeCentralSession(task.agentSessionId);
    return centralSession === "unknown"
      ? verdict
      : judgeNodeResponse({ ...verdict.facts, centralSession });
  }

  /** 로컬 소유를 정리한다. 정리 포트가 이어져 있으면 그것을, 없으면 기본 정리를 쓴다. */
  async releaseLocalOwnershipThroughPorts(task: Task): Promise<void> {
    await (this.ports.releaseLocalOwnership ?? ((owned) => this.releaseLocalOwnership(owned)))(task);
  }

  /** 중앙 세션이 없을 때의 로컬 소유 정리다. 러너를 놓고 등록 번호와 task를 잊는다. */
  async releaseLocalOwnership(task: Task): Promise<void> {
    const runner = task.runner;
    if (runner && releaseTaskRunner(task, runner)) {
      try {
        await runner.dispatcher.detachHost();
      } catch (error) {
        this.deps.logger.warn(
          { err: error, sessionId: task.agentSessionId },
          "runner detach failed while releasing local ownership",
        );
      }
    }
    task.executionRegistration = undefined;
    task.executionPromise = undefined;
    this.ports.forgetTask?.(task.agentSessionId);
  }

}
