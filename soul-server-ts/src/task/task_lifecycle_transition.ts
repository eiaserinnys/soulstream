/**
 * 500줄을 넘긴 파일이다(카드 #1266 U2a 이전부터 678줄). 종료 영속, 거절 정리, 멈춤 장벽, 완료
 * 정산 미결이 한 전이 객체의 상태(포트, 완료 통지, 영속)를 같이 써서 지금은 쪼개면 포트를 되넘기는
 * 얕은 모듈이 된다. 미결 기록 자체는 terminal_settlement_track.ts로 뺐다. 거절 정리와 삭제 정산을
 * 따로 떼는 것은 후속 정리 몫이다.
 */
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
import type { CompletionSettlementLedger } from "./completion_settlement_store.js";
import { TerminalSettlementTrack, closeSettledTerminal } from "./terminal_settlement_track.js";
import type { CompletionNotifyOptions, CompletionSettleResult } from "./completion_notifier.js";
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
  notify(task: Task, options?: CompletionNotifyOptions): Promise<CompletionSettleResult | void>;
  notifyForDelete?(task: Task): Promise<boolean>;
  notifyBackgroundStopped?(task: Task, firstSentence: string): Promise<void>;
}

/** 종료 응답의 정리 의도를 실행하는 포트다. 모두 없을 수 있다. */
export interface TerminationCleanupPorts {
  /**
   * 완료 정산 미결의 저장소다. 있으면 종료를 아웃박스에 붙이기 전에 미결을 영속하고,
   * 완료 전달을 등록하거나 정책상 생략을 확인한 뒤에 지운다. 완료 전달 v2가 꺼진 노드는
   * 장부 확인이 없으므로 잇지 않는다.
   */
  settlement?: CompletionSettlementLedger;
  /**
   * 완료 정산 미결 닫기의 호출점이다. 영구 거절 칸과 중앙 세션 없음 칸이 부른다.
   * 없으면 아무것도 하지 않는다.
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
  /** 이번 종료가 쓴 완료 정산 미결의 키다. 저장소가 이어져 있고 종료를 올렸을 때만 있다. */
  settlementKey?: string;
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
      settlement: deps.settlement,
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
    const key = persistence.settlementKey;
    if (!requireRegistration && !persistence.terminalTransitionApplied) {
      // 적용되지 않은 종료는 정산할 것이 없다. 남은 미결은 훑기가 중앙을 보고 닫는다.
      this.releaseSettlementKey(key);
      return true;
    }
    if (!task.callerSessionId || !this.completionNotifier) {
      await this.closeSettlementKey(task, key);
      return true;
    }

    try {
      if (requireRegistration) {
        const notifyForDelete = this.completionNotifier.notifyForDelete;
        if (!notifyForDelete) {
          this.deps.logger.warn(
            { sessionId: task.agentSessionId },
            "completion notifier cannot confirm registration before delete",
          );
          this.releaseSettlementKey(key);
          return false;
        }
        const registered = await notifyForDelete.call(this.completionNotifier, task);
        if (registered) await this.closeSettlementKey(task, key);
        else this.releaseSettlementKey(key);
        return registered;
      }
      const result = await this.completionNotifier.notify(task);
      if (result?.kind === "retry_required") {
        this.releaseSettlementKey(key);
        return false;
      }
      await this.closeSettlementKey(task, key);
      return true;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "completion notification failed after terminal transition was applied",
      );
      this.releaseSettlementKey(key);
      return false;
    }
  }

  /**
   * 「다음 세대가 이어 감」으로 완료 통지를 건너뛴 종료의 미결을 닫는다. 호출한 쪽이 이어가기
   * 예약이 실제로 만들어진 것을 확인한 뒤에만 부른다.
   */
  async settleSkippedCompletion(
    task: Task,
    persistence: TaskFinalStatePersistenceResult,
  ): Promise<void> {
    await this.closeSettlementKey(task, persistence.settlementKey);
  }

  /** 정상 길이 끝났으므로 이 종료의 미결 쥠을 푼다. 남은 미결은 훑기가 이어 받는다. */
  releaseSettlementHold(persistence: TaskFinalStatePersistenceResult): void {
    this.releaseSettlementKey(persistence.settlementKey);
  }

  /** 정상 길이 쥔 미결을 풀고 훑기에 맡긴다. */
  private releaseSettlementKey(key: string | undefined): void {
    if (key !== undefined) this.ports.settlement?.release(key);
  }

  private async closeSettlementKey(task: Task, key: string | undefined): Promise<void> {
    await closeSettledTerminal(this.ports.settlement, this.deps.logger, task.agentSessionId, key);
  }

  /**
   * 세션 행을 지우기 전에 그 세션의 완료 정산 미결을 정산한다. 종료가 중앙에 기록된
   * 세션이 미결을 가지면 등록이나 정책상 생략을 확인한다. 등록하지 못하면 던져 삭제를 멈춘다.
   */
  async settleBeforeDelete(task: Task): Promise<void> {
    const settlement = this.ports.settlement;
    if (!settlement) return;
    if (!(await settlement.hasPendingForSession(task.agentSessionId))) return;
    if (!task.terminationEventRecorded) return;
    const registered = await this.notifyCompletionIfApplied(
      task,
      { newlyFinalized: false, terminalTransitionApplied: false },
      { requireRegistration: true },
    );
    if (!registered) {
      throw new Error(
        `completion notification registration failed before delete: ${task.agentSessionId}`,
      );
    }
  }

  /** 삭제를 마친 세션의 미결을 남기지 않는다(중앙 줄이 없어 훑기가 되살릴 수 없다). */
  async discardSettlementsAfterDelete(sessionId: string): Promise<void> {
    try {
      await this.ports.settlement?.closeAllForSession(sessionId);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId },
        "completion settlement of a deleted session could not be removed",
      );
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
      persistence = await this.persistFinalState(task, true, { settleCompletion: true });
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

  /**
   * `settleCompletion`이면 이 종료는 완료 통지 의무가 걸린다: 미결을 영속하고 호출자가
   * `notifyCompletionIfApplied`로 정산한다. 통지하지 않는 종료(오류 표시 등)는 미결을 만들지 않는다.
   * `registrationId`는 task에 실행 등록이 없을 때 종료가 지킬 러너 등록이다(잇기 거절의 오류 종료).
   */
  async persistExecutorFinalState(
    task: Task,
    retryUnrecordedTerminal = false,
    options: { settleCompletion?: boolean; registrationId?: string } = {},
  ): Promise<TaskFinalStatePersistenceResult> {
    return await this.persistFinalState(task, retryUnrecordedTerminal, options);
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
    options: { settleCompletion?: boolean; registrationId?: string } = {},
  ): Promise<TaskFinalStatePersistenceResult> {
    const termination = finalizeTaskTermination(task);
    if (termination.newlyFinalized) {
      task.reviewState = reviewStateAfterTerminal(task.reviewRequired === true);
    }
    let settled: { applied: boolean; settlementKey?: string } = { applied: false };
    if (
      (termination.newlyFinalized || retryUnrecordedTerminal)
      && isTerminalTaskStatus(task.status)
      && !task.terminationEventRecorded
    ) {
      settled = await this.enqueueAndAwaitSessionEnded(
        task,
        termination.reason,
        termination.detail,
        options,
      );
    }
    return {
      newlyFinalized: termination.newlyFinalized,
      terminalTransitionApplied: settled.applied,
      ...(settled.settlementKey === undefined
        ? {}
        : { settlementKey: settled.settlementKey }),
    };
  }

  /**
   * 종료 사건을 올리고 중앙의 적용을 기다린다. 완료 정산 미결은 아웃박스에 붙이기 전에
   * 영속한다(불변식 1): 붙이기가 던지면 지우고, 붙은 뒤에는 아웃박스 좌표를, 적용 응답을
   * 받으면 적용된 종료 사건 번호를 덧붙인다. 러너 등록과 정상 보유 여부는 보지 않는다.
   */
  private async enqueueAndAwaitSessionEnded(
    task: Task,
    terminationReason: string,
    terminationDetail: string | null,
    options: { settleCompletion?: boolean; registrationId?: string },
  ): Promise<{ applied: boolean; settlementKey?: string }> {
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
    const registrationId = task.executionRegistration?.registrationId ?? options.registrationId;
    const context: NodeResponseContext = {
      call: "termination",
      registrationId: registrationId ?? null,
      retained: task.runnerRetainedForDetachedWork === true,
    };
    const ledger = options.settleCompletion === true ? this.ports.settlement : undefined;
    const track = ledger
      ? await TerminalSettlementTrack.begin(ledger, this.deps.logger, task, event._dedupe_key, registrationId)
      : undefined;
    const settlementKey = track?.key;
    let application: Awaited<
      ReturnType<EventPersistence["enqueueTerminalTransitionAndWaitForApplication"]>
    >;
    try {
      application = track
        ? await this.deps.persistence.enqueueTerminalTransitionAndWaitForApplication(
            task.agentSessionId,
            event,
            effect,
            registrationId,
            track.onAppended,
          )
        : registrationId === undefined
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
      await track?.failed();
      const facts = nodeResponseFactsFromError(context, error);
      // 응답이 아닌 오류와 응답 없음은 다시 올릴 수 있으므로 그대로 던진다.
      if (!facts || facts.route === "no_response") throw error;
      await this.settleRejection(task, judgeNodeResponse(facts), this.rejectedRegistrationOf(task, registrationId));
      return { applied: false, ...(settlementKey === undefined ? {} : { settlementKey }) };
    }
    applyCanonicalSessionProjection(task, application.canonicalSession);
    if (
      isTerminalTaskStatus(task.status)
      && application.canonicalExecutionRegistration == null
    ) {
      task.executionRegistration = undefined;
    }
    const verdict = application.applied
      ? undefined
      : judgeNodeResponse(nodeResponseFactsFromApplication(context, application));
    if (application.applied || verdict?.decision.cell === "applied") {
      await track?.applied(application.canonicalSession.termination_event_id);
      return { applied: true, ...(settlementKey === undefined ? {} : { settlementKey }) };
    }
    await this.settleRejection(task, verdict!, this.rejectedRegistrationOf(task, registrationId));
    track?.release();
    return { applied: false, ...(settlementKey === undefined ? {} : { settlementKey }) };
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

  /**
   * 로컬 소유를 정리한다. 러너를 놓고 등록 번호를 잊은 뒤 task를 잊는다. 거절된 종료의 표시
   * (`rejectedTerminationRegistrationId`)는 메모리에만 있어 task와 함께 사라지므로, 잊기 전에 그
   * 등록을 은퇴시킨다. 은퇴하지 못해 표시가 남으면 task를 잊지 않는다: 잊으면 러너 복구가 같은
   * 종료를 한 번 더 올린다.
   */
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
    await this.retireRejectedTerminal(task);
    // 은퇴를 맡을 러너 복구가 이어져 있을 때만 표시가 남은 task를 붙든다. 이어져 있지 않으면
    // (러너 프로세스를 쓰지 않는 노드) 표시를 지울 주체가 없으므로 지금까지처럼 잊는다.
    if (
      task.rejectedTerminationRegistrationId !== undefined
      && this.ports.retireRejectedRegistration !== undefined
    ) {
      this.deps.logger.warn(
        {
          sessionId: task.agentSessionId,
          registrationId: task.rejectedTerminationRegistrationId,
        },
        "task kept in memory: its rejected terminal registration is not retired yet",
      );
      return;
    }
    this.ports.forgetTask?.(task.agentSessionId);
  }

}
