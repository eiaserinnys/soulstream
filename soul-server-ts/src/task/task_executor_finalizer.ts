import type { Logger } from "pino";

import type {
  CodexDetachedCommandRuntimeActivity,
  SupportsCodexDetachedCommandRuntime,
  SupportsDetachedClaudeRuntime,
} from "../engine/protocol.js";

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
import { countPendingClaudeBackgroundRuntimeWork } from "./claude_runtime_state.js";
import {
  buildRetentionCapExceededSentence,
  DEFAULT_CLAUDE_BACKGROUND_RETENTION_CAP_MS,
} from "./claude_background_retention_notice.js";

interface TaskExecutorFinalizerDeps {
  lifecycleTransition: Pick<
    TaskLifecycleTransition,
    "persistExecutorFinalState" | "notifyCompletionIfApplied"
  > & Partial<Pick<TaskLifecycleTransition, "retireRejectedTerminal" | "settleSkippedCompletion" | "releaseSettlementHold">>;
  logger: Logger;
  /** 보유가 followup 없이 풀릴 때 부른 세션에 알리는 길. */
  notifyBackgroundStopped?: (task: Task, firstSentence: string) => Promise<void>;
  /** 클로드 백그라운드 보유 상한. 넘기면 보유를 풀고 알린다. */
  retentionCapMs?: number;
}

export type RetainedRunnerReleaseResult =
  | "not_released"
  | "released"
  | "retry_required";

type DetachedWorkRetention = "retained" | "codex_inactive" | "not_retained";
type CodexActivityDisposition = "retain" | "inactive" | "unsupported";

export class TaskExecutorFinalizer {
  private readonly retentionCapTimers = new Map<Task, ReturnType<typeof setTimeout>>();
  private readonly retentionCapMs: number;

  constructor(private readonly deps: TaskExecutorFinalizerDeps) {
    this.retentionCapMs = deps.retentionCapMs
      ?? DEFAULT_CLAUDE_BACKGROUND_RETENTION_CAP_MS;
  }

  async finalize(
    task: Task,
    /**
     * 실행이 끝난 턴들의 전달을 정산한다. 완료든 오류든 관계없이 terminal
     * 전이가 적용된 뒤에 호출한다.
     */
    settleEndedTurnDeliveries?: () => Promise<void>,
    /**
     * Terminal 저장과 runner 해제 뒤, 완료 통지 앞에서 실행되는 선택적 단계.
     * true를 돌려주면 이번 실행의 완료 통지만 건너뛴다(다음 세대가 이어감).
     */
    beforeNotify?: (terminalTransitionApplied: boolean) => Promise<boolean>,
  ): Promise<void> {
    // Snapshot before closeEngine can terminalize the remaining background
    // work: the completion notice reports what was still running at turn end.
    task.backgroundRuntimeAtTurnEnd = countPendingClaudeBackgroundRuntimeWork(task);
    const persistence = await this.deps.lifecycleTransition.persistExecutorFinalState(task, true, { settleCompletion: true });
    try {
      // The sessions-row release ACK is the durable terminal/owner boundary. Keep
      // the runner handle until it commits so the same owner can retry on failure.
      await this.closeEngine(task);
      // 거절된 종료의 등록은 러너를 닫거나 보유할지 정한 뒤에 은퇴시킨다.
      await this.deps.lifecycleTransition.retireRejectedTerminal?.(task);
      if (persistence.terminalTransitionApplied && settleEndedTurnDeliveries) {
        await settleEndedTurnDeliveries();
      }
      if (beforeNotify && await beforeNotify(persistence.terminalTransitionApplied)) {
        // 이어가기 예약이 만들어진 것을 확인한 뒤의 생략이므로 완료 정산 미결을 닫는다.
        await this.deps.lifecycleTransition.settleSkippedCompletion?.(task, persistence);
        return;
      }
      await this.deps.lifecycleTransition.notifyCompletionIfApplied(task, persistence);
    } finally {
      // 도중에 던져도 미결은 남는다. 정상 길의 쥠만 풀어 훑기가 이어 받게 한다.
      this.deps.lifecycleTransition.releaseSettlementHold?.(persistence);
    }
  }

  async releaseRetainedClaudeRunner(task: Task): Promise<void> {
    const runner = task.runner;
    if (task.runnerRetainedForDetachedWork !== true || !runner) return;
    if (await this.shouldRetainClaudeRuntime(task, runner.engine)) return;
    if (task.runnerRetainedForDetachedWork !== true) return;

    if (!releaseTaskRunner(task, runner)) return;
    this.clearRetentionCap(task);
    await this.closeRunnerDispatcher(task, runner);
  }

  async retainRunnerIfDetachedWorkActive(
    task: Task,
    runner: NonNullable<Task["runner"]>,
  ): Promise<DetachedWorkRetention> {
    if (task.runnerIsOfflineReplay === true) return "not_retained";
    if (runner.dispatcher.hasClosedEngineFailureForFinalization?.() === true) {
      return "not_retained";
    }
    const retention = await this.detachedWorkRetention(task, runner.engine);
    if (task.runner !== runner) return "not_retained";
    if (runner.dispatcher.hasLostRunner?.() === true) return "not_retained";
    if (retention === "retained" || retention === "codex_inactive") {
      task.runnerRetainedForDetachedWork = true;
      if (retention === "retained") this.scheduleRetentionCap(task, runner);
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
    this.clearRetentionCap(task);
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
    if (runner) this.clearRetentionCap(task);
    if (runner) releaseTaskRunner(task, runner);
  }

  /**
   * 보유 상한 타이머. 넘기면 엔진 활동과 무관하게 보유를 풀고(남은 백그라운드는
   * Query와 함께 멈춘다) 부른 세션에 「더 보고하지 않습니다」를 보낸다(R3).
   */
  private scheduleRetentionCap(
    task: Task,
    runner: NonNullable<Task["runner"]>,
  ): void {
    if (!Number.isFinite(this.retentionCapMs) || this.retentionCapMs <= 0) return;
    this.clearRetentionCap(task);
    const timer = setTimeout(() => {
      this.retentionCapTimers.delete(task);
      void this.onRetentionCapExpired(task, runner);
    }, this.retentionCapMs);
    (timer as { unref?: () => void }).unref?.();
    this.retentionCapTimers.set(task, timer);
  }

  private clearRetentionCap(task: Task): void {
    const timer = this.retentionCapTimers.get(task);
    if (!timer) return;
    this.retentionCapTimers.delete(task);
    clearTimeout(timer);
  }

  private async onRetentionCapExpired(
    task: Task,
    runner: NonNullable<Task["runner"]>,
  ): Promise<void> {
    if (task.runnerRetainedForDetachedWork !== true || task.runner !== runner) return;
    if (!releaseTaskRunner(task, runner)) return;
    await this.closeRunnerDispatcher(task, runner);
    const firstSentence = buildRetentionCapExceededSentence(this.retentionCapMs);
    const notify = this.deps.notifyBackgroundStopped;
    if (!notify) {
      this.deps.logger.warn(
        { sessionId: task.agentSessionId },
        "background retention cap released without a caller notice port",
      );
      return;
    }
    try {
      await notify(task, firstSentence);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "background retention cap notice failed",
      );
    }
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
