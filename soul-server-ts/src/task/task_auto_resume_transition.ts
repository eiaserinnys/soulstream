import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { PersistentResumeObserver } from "../context/persistent_jev_observer.js";

import {
  createExecutionActivation,
  isTerminalTaskStatus,
  type CallerInfo,
  type ExecutionActivation,
  type InterventionMessage,
  type Task,
} from "./task_models.js";
import { enqueueInterventionOnce } from "./task_intervention_queue.js";
import {
  captureTerminalResumeSnapshot,
  findLastCallerInfoMetadataEntry,
  stableSerialize,
  type TerminalResumeSnapshot,
} from "./task_auto_resume_snapshot.js";
import { annotateTerminalSystemAbort } from "./system_abort_notice.js";
import { hasLiveExecutionEvidence } from "./task_execution_evidence.js";
import { buildCallerInfoMetadataEntry } from "./task_metadata.js";
import { releaseTaskRunner } from "./task_runner_release.js";
import {
  NodeResponseRejectedError,
  judgeNodeResponse,
  nodeResponseFactsFromApplication,
  nodeResponseFactsFromError,
  type NodeResponseVerdict,
} from "./state/node_response_handling.js";
import { reviewStateAfterFollowup } from "./session_review.js";
import { applyCanonicalSessionProjection } from
  "./task_canonical_session_projection.js";
import {
  buildUserMessageEvent,
  finishUserMessageEvent,
  persistUserMessageEvent,
} from "./task_user_message_events.js";
import {
  buildDeliveryInputDedupeKey,
} from "./delivery_identity.js";
import { buildDeliveryInputUuid } from "@soulstream/wire-schema/delivery";
import { ResumeRejectedError } from "./resume_rejected_error.js";
import type { LlmContinuation, LlmContinuationTurn } from "./task_llm_continuation.js";

const persistedResumeInputs = new WeakMap<Task, Set<string>>();

export type AutoResumeCallback = (
  task: Task,
  activation?: ExecutionActivation,
) => void | Promise<void>;

export interface AutoResumeTransitionDeps {
  logger: Logger;
  persistence?: EventPersistence;
  observePersistentResume?: PersistentResumeObserver;
  contextBuilder?: ExecutionContextBuilder;
  agentRegistry?: AgentRegistry;
  /**
   * 거절 응답이 고른 정리 의도(로컬 소유 정리, 미결 닫기)를 실행하고 최종 판정을 돌려준다.
   * 없으면 정리 없이 판정만 담아 던진다.
   */
  settleRejection?: (task: Task, verdict: NodeResponseVerdict) => Promise<NodeResponseVerdict>;
}

/**
 * Auto-resume transition for terminal and ownerless-running tasks.
 *
 * Owns the ordered side effects that turn a completed/error/interrupted task
 * back into a running task for the next user turn:
 * resume capability validation -> caller metadata promotion -> user_message
 * persistence + separate durable running effect -> post-transition durable
 * admission -> task state transition -> user_message broadcast -> executor
 * resume callback. Orch projects the running status from the durable effect,
 * so a closed host WebSocket cannot lose the transition.
 */
export class AutoResumeTransition {
  private llmContinuation?: LlmContinuation;

  constructor(private readonly deps: AutoResumeTransitionDeps) {}

  /** llm 세션은 claude 엔진 대신 이 이어 쓰기로 재개한다. */
  attachLlmContinuation(continuation: LlmContinuation): void {
    this.llmContinuation = continuation;
  }

  private async prepareLlmTurn(
    task: Task,
    message: InterventionMessage,
  ): Promise<LlmContinuationTurn> {
    if (!this.llmContinuation) {
      throw new ResumeRejectedError(
        "이 노드는 llm 세션을 이어 쓰도록 설정되어 있지 않습니다. 새 세션에서 다시 물어 주세요.",
      );
    }
    return await this.llmContinuation.prepare(task, message);
  }

  private async settle(task: Task, verdict: NodeResponseVerdict): Promise<NodeResponseVerdict> {
    return await this.deps.settleRejection?.(task, verdict) ?? verdict;
  }

  async resumeQueuedAfterTerminal(
    task: Task,
    onResume: AutoResumeCallback,
  ): Promise<boolean> {
    if (!isTerminalTaskStatus(task.status)) return false;
    const message = task.interventionQueue[0];
    if (!message) return false;
    // This path skips addIntervention, so annotate the original queued message
    // in place before prepareTaskForAutoResume clears the terminal snapshot.
    annotateTerminalSystemAbort(task, message);
    await this.resume(task, message, onResume, { publishUserMessage: false });
    return true;
  }

  async resume(
    task: Task,
    message: InterventionMessage,
    onResume: AutoResumeCallback,
    options: {
      publishUserMessage?: boolean;
      afterRunningTransition?: () => Promise<void>;
    } = {},
  ): Promise<{ autoResumed: true }> {
    const releaseClaim = task.runnerReleaseClaim;
    if (releaseClaim) await this.awaitRunnerReleaseClaim(task, releaseClaim);
    // 거절 응답의 등록 비교가 쓰는 번호다. 재개가 시작될 때의 등록이며, 낡은 등록의 거절이
    // 새 실행의 중앙 상태를 오류로 덮지 않게 한다(R5, 대조 task_lifecycle_transition).
    const registrationId = task.executionRegistration?.registrationId
      ?? task.runner?.dispatcher.registrationId?.()
      ?? null;
    let originalStatus = task.status;
    if (originalStatus === "running" && hasLiveExecutionEvidence(task)) {
      throw new Error(
        `auto-resume running transition rejected for ${task.agentSessionId}`,
      );
    }
    // llm 갈래는 profileId 검사와 claude 엔진 시작보다 앞선다. 거절은 어떤 이벤트도 쓰기 전에 던진다.
    const llmTurn = task.sessionType === "llm"
      ? await this.prepareLlmTurn(task, message)
      : undefined;
    if (!llmTurn) this.requireResumableProfile(task);
    let originalTerminalEventId = task.terminalEventId;
    const activation = createExecutionActivation();
    // The executor settles this exact delivery if preparation fails before a turn.
    activation.admissionMessage = message;
    task.status = "initializing";
    task.executionActivation = activation;
    void activation.promise.catch(() => undefined);

    try {
      await this.awaitExecutionDrain(task);
      // Replay can apply a terminal while the activation barrier is in place.
      // Resume and any compensation must use that terminal, before async metadata work.
      if (isTerminalTaskStatus(task.status)) {
        originalStatus = task.status;
        task.status = "initializing";
      }
      originalTerminalEventId = task.terminalEventId;
      const transitionRevision = task.lastEventId;
      const expectedTerminalEventId = isTerminalTaskStatus(originalStatus)
        ? task.terminalEventId ?? null
        : undefined;
      const terminalSnapshot = isTerminalTaskStatus(originalStatus)
        ? captureTerminalResumeSnapshot(
            task,
            originalStatus as TerminalResumeSnapshot["status"],
          )
        : undefined;
      await this.closeStaleEngine(task);
      await this.promoteCallerInfo(task, message.callerInfo);

      const dedupeKey = message.deliveryId
        ? buildDeliveryInputDedupeKey(message.deliveryId)
        : undefined;
      const userMessageEvent = options.publishUserMessage === false
        ? null
        : {
          ...buildUserMessageEvent({
            text: message.text,
            conversationText: message.conversationText,
            inputId: message.deliveryId
              ? buildDeliveryInputUuid(message.deliveryId)
              : undefined,
            dedupeKey,
            user: message.user,
            callerInfo: message.callerInfo ?? task.callerInfo,
            attachmentPaths: message.attachmentPaths,
            attachmentIds: message.attachmentIds,
            attachmentBindings: message.attachmentBindings,
            contextItems: message.context,
            purpose: message.purpose,
          }),
          ...llmTurn?.userMessageFields,
        };
      const resumedReviewState = reviewStateAfterFollowup(
        task.reviewState ?? "not_required",
      );
      if (userMessageEvent && (!dedupeKey || !persistedResumeInputs.get(task)?.has(dedupeKey))) {
        await persistUserMessageEvent(task, userMessageEvent, this.deps);
        if (dedupeKey) {
          const persisted = persistedResumeInputs.get(task) ?? new Set<string>();
          persisted.add(dedupeKey);
          persistedResumeInputs.set(task, persisted);
        }
      }
      if (!this.deps.persistence) {
        throw new Error("running transition durable event persistence is required");
      }
      const resumeContext = { call: "resume", registrationId } as const;
      let application: Awaited<ReturnType<
        NonNullable<typeof this.deps.persistence>["enqueueRunningTransitionAndWaitForApplication"]
      >>;
      try {
        application = await this.deps.persistence
          .enqueueRunningTransitionAndWaitForApplication(task.agentSessionId, {
            reviewState: resumedReviewState,
            transitionId: `resume:${transitionRevision}`,
            ...(expectedTerminalEventId === undefined
              ? {}
              : { expectedTerminalEventId }),
          });
      } catch (error) {
        const facts = nodeResponseFactsFromError(resumeContext, error);
        if (!facts || facts.route === "no_response") throw error;
        throw new NodeResponseRejectedError(
          await this.settle(task, judgeNodeResponse(facts)),
          `auto-resume running transition rejected for ${task.agentSessionId}`,
          { cause: error },
        );
      }
      if (!application.applied) {
        applyCanonicalSessionProjection(task, application.canonicalSession);
        throw new NodeResponseRejectedError(
          await this.settle(
            task,
            judgeNodeResponse(nodeResponseFactsFromApplication(resumeContext, application)),
          ),
          `auto-resume running transition rejected for ${task.agentSessionId}`,
        );
      }
      if (dedupeKey) persistedResumeInputs.get(task)?.delete(dedupeKey);
      if (terminalSnapshot) {
        activation.setFailureCompensation?.(async (error) => {
          // The restored terminal repeats the previous detail, so this line is
          // the only record of why this admission actually failed.
          this.deps.logger.warn(
            { err: error, sessionId: task.agentSessionId, transitionRevision },
            "execution admission failed after the running transition; restoring the previous terminal",
          );
          await this.compensateRunningTransition(
            task,
            terminalSnapshot,
            transitionRevision,
            registrationId,
          );
        });
      }
      await options.afterRunningTransition?.();
      applyCanonicalSessionProjection(task, application.canonicalSession);
      if (userMessageEvent) {
        await finishUserMessageEvent(task, userMessageEvent, this.deps);
      }
      const inputId = userMessageEvent?.input_id;
      const source = message.callerInfo?.source;
      if (
        originalStatus !== "running" && originalStatus !== "initializing" &&
        task.persistent === true &&
        (source === "slack" || source === "browser" || source === "soul-app") &&
        typeof inputId === "string" &&
        this.deps.observePersistentResume
      ) {
        try {
          void this.deps.observePersistentResume({
            sessionId: task.agentSessionId,
            inputId,
            request: message.text,
          }).catch(() => {
            this.deps.logger.warn(
              { sessionId: task.agentSessionId, failureKind: "observer" },
              "persistent Jev candidate observation skipped",
            );
          });
        } catch {
          this.deps.logger.warn(
            { sessionId: task.agentSessionId, failureKind: "observer" },
            "persistent Jev candidate observation skipped",
          );
        }
      }
      if (llmTurn) {
        resetTaskForResumedTurn(task, message, "running");
        task.executionActivation = undefined;
        activation.resolve();
        void llmTurn.run();
        return { autoResumed: true };
      }
      prepareTaskForAutoResume(task, message, "initializing");
      onResume(task, activation);
      return { autoResumed: true };
    } catch (error) {
      if (task.executionActivation === activation) {
        task.executionActivation = undefined;
      }
      await activation.reject(error);
      if (task.status === "initializing") {
        task.status = originalStatus;
        task.terminalEventId = originalTerminalEventId;
      }
      try {
        await activation.promise;
      } catch (activationError) {
        throw activationError;
      }
      throw error;
    }
  }

  private requireResumableProfile(task: Task): void {
    if (!this.deps.agentRegistry) return;
    if (!task.profileId) {
      throw new ResumeRejectedError(
        "이 세션은 에이전트 정보가 없어 이어 쓸 수 없습니다. 새 세션에서 다시 시작해 주세요.",
      );
    }
    if (task.agentProfileSnapshot) return;
    if (!this.deps.agentRegistry.get(task.profileId)) {
      throw new Error(
        `Cannot auto-resume ${task.agentSessionId}: unknown agent profile ${task.profileId}`,
      );
    }
  }

  private async awaitExecutionDrain(task: Task): Promise<void> {
    if (!task.executionPromise) return;
    try {
      await task.executionPromise;
    } catch {
      // ignore; finalize has drained.
    } finally {
      task.executionPromise = undefined;
    }
  }

  private async awaitRunnerReleaseClaim(
    task: Task,
    firstClaim: NonNullable<Task["runnerReleaseClaim"]>,
  ): Promise<void> {
    let claim: Task["runnerReleaseClaim"] = firstClaim;
    while (claim) {
      await claim.completion;
      claim = task.runnerReleaseClaim;
    }
  }

  private async closeStaleEngine(task: Task): Promise<void> {
    if (!task.runner) return;
    if (task.runnerRetainedForDetachedWork === true) return;
    const runner = task.runner;
    releaseTaskRunner(task, runner);
    try {
      await runner.dispatcher.close();
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "stale engine close failed before auto-resume",
      );
    }
  }

  private async promoteCallerInfo(
    task: Task,
    callerInfo: CallerInfo | undefined,
  ): Promise<void> {
    const entry = buildCallerInfoMetadataEntry(callerInfo);
    if (!entry) return;
    task.callerInfo = callerInfo;
    const previousCallerInfo = findLastCallerInfoMetadataEntry(task.metadata ?? []);
    if (
      previousCallerInfo !== undefined
      && stableSerialize(previousCallerInfo) === stableSerialize(entry)
    ) {
      return;
    }
    task.metadata = [...(task.metadata ?? []), entry];
    if (!this.deps.persistence) {
      this.deps.logger.warn(
        { sessionId: task.agentSessionId },
        "caller_info metadata effect unavailable — continuing auto-resume",
      );
      return;
    }
    try {
      await this.deps.persistence.enqueueMetadataEffect(task.agentSessionId, entry);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "caller_info metadata append failed — continuing auto-resume",
      );
    }
  }

  private async compensateRunningTransition(
    task: Task,
    snapshot: TerminalResumeSnapshot,
    transitionRevision: number,
    registrationId: string | null,
  ): Promise<void> {
    const persistence = this.deps.persistence;
    if (!persistence) {
      throw new Error("running transition compensation persistence is required");
    }
    const compensatedAt = new Date();
    const event = {
      type: "session_ended" as const,
      status: snapshot.status,
      termination_reason: snapshot.terminationReason,
      termination_detail: snapshot.terminationDetail,
      timestamp: Math.floor(compensatedAt.getTime() / 1000),
      _dedupe_key:
        `resume_compensation:${task.agentSessionId}:${transitionRevision}`,
    };
    const compensationContext = {
      call: "resume_compensation_terminal",
      registrationId,
    } as const;
    let application: Awaited<ReturnType<
      typeof persistence.enqueueTerminalTransitionAndWaitForApplication
    >>;
    try {
      application = await persistence.enqueueTerminalTransitionAndWaitForApplication(
        task.agentSessionId,
        event,
        {
          kind: "terminal_transition",
          status: snapshot.status,
          termination_reason: snapshot.terminationReason,
          termination_detail: snapshot.terminationDetail,
          review_state: snapshot.reviewState,
          last_assistant_text: snapshot.lastAssistantText,
          updated_at: compensatedAt.toISOString(),
        },
      );
    } catch (error) {
      const facts = nodeResponseFactsFromError(compensationContext, error);
      if (!facts || facts.route === "no_response") throw error;
      throw new NodeResponseRejectedError(
        await this.settle(task, judgeNodeResponse(facts)),
        `running transition compensation rejected for ${task.agentSessionId}`,
        { cause: error },
      );
    }
    if (!application.applied) {
      // 이 시도를 그만둔다. 다시 올릴 보정은 없다.
      throw new NodeResponseRejectedError(
        await this.settle(
          task,
          judgeNodeResponse(
            nodeResponseFactsFromApplication(compensationContext, application),
          ),
        ),
        `running transition compensation rejected for ${task.agentSessionId}`,
      );
    }
    applyCanonicalSessionProjection(task, application.canonicalSession);
    task.result = snapshot.result;
    task.error = snapshot.error;
    task.pendingTerminationHint = snapshot.pendingTerminationHint;
    task.pendingTerminationDetail = snapshot.pendingTerminationDetail;
    if (task.executionActivation) task.executionActivation = undefined;
  }

}

export function prepareTaskForAutoResume(
  task: Task,
  message: InterventionMessage,
  status: "initializing" | "running",
): void {
  task.clientId = message.user;
  resetTaskForResumedTurn(task, message, status);
  enqueueInterventionOnce(task, message);
}

function resetTaskForResumedTurn(
  task: Task,
  message: InterventionMessage,
  status: "initializing" | "running",
): void {
  task.prompt = message.text;
  if (message.callerInfo !== undefined) {
    task.callerInfo = message.callerInfo;
  }
  task.attachmentPaths = message.attachmentPaths ?? [];
  task.attachmentIds = message.attachmentIds ?? [];
  task.attachmentBindings = message.attachmentBindings ?? [];
  task.contextItems = message.context ?? [];
  task.status = status;
  task.reviewState = reviewStateAfterFollowup(task.reviewState ?? "not_required");
  task.completedAt = undefined;
  task.error = undefined;
  task.result = undefined;
  task.terminationReason = undefined;
  task.terminationDetail = undefined;
  task.lastSystemAbortNoticeKey = undefined;
  task.pendingTerminationHint = undefined;
  task.pendingTerminationDetail = undefined;
  task.rateLimitStopInfo = undefined;
  task.backgroundRuntimeAtTurnEnd = undefined;
  task.terminationEventRecorded = false;
  task.terminalEventId = undefined;
  task.terminalDedupeIdentity = undefined;
}
