import { randomUUID } from "node:crypto";

import type { AutoResumeCallback, AutoResumeTransition } from "./task_auto_resume_transition.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { SessionDeliveryRow } from "../db/session_db_types.js";
import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  type CallerInfo,
  type InterventionMessage,
  type Task,
} from "./task_models.js";
import type { DeliveryIntent } from "./delivery_contract.js";
import type {
  RunningInterventionResult,
  RunningInterventionTransition,
} from "./task_running_intervention_transition.js";
import type {
  DeliveryLedgerAdmission,
  TaskDeliveryLedgerGate,
} from "./task_delivery_ledger_gate.js";
import { readCanonicalDeliveryPayload } from "./delivery_payload.js";
import type { SessionNotificationPublisher } from "./task_session_notification.js";
import { isExecutionOwnershipConflictError } from "./execution_ownership.js";
import {
  isNotificationDeliveryIntent,
} from "./session_delivery_notification_payload.js";

type NotificationPublication = Awaited<
  ReturnType<SessionNotificationPublisher["publish"]>
>;

/**
 * `addIntervention` 결과. Python `task_manager.add_intervention` L590-595 정본 형상.
 *
 * - running 세션 → `engine.intervene()`가 현재 전달하면 `{delivered: true}`,
 *   전달하지 못하면 소비 시점과 사유가 명시된 queue/defer 결과.
 * - active + logical turn complete → 새 generation으로 `{autoResumed: true}`.
 * - completed/error/interrupted → 사용자 입력과 runtime follow-up은
 *   `{autoResumed: true}`, completion notification은 다음 명시적 turn까지 queued.
 */
export type AddInterventionResult =
  | RunningInterventionResult
  | { autoResumed: true }
  | { suppressed: true; deliveryId: string; reason: string };

/** addIntervention이 받는 메시지. dispatcher가 wire payload에서 조립. */
export interface AddInterventionParams {
  agentSessionId: string;
  text: string;
  user: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
  context?: ContextItem[];
  source?: string;
  deliveryId?: string;
  deliveryIntent?: DeliveryIntent;
  completionId?: string;
  relationKey?: string;
  producerTerminalRevision?: string;
  parentDeliveryId?: string;
  callerTurnId?: string;
  deliveryCreatedAt?: string;
  deliveryLeaseOwner?: string;
  followupAttempt?: number;
  followupKey?: string;
  followupTaskIds?: string[];
  /** Exact JSONB/hash read back from a durable delivery row. Internal; never wire-forwarded. */
  storedDeliveryPayload?: Record<string, unknown>;
  storedDeliveryPayloadHash?: string;
  /**
   * Scheduler dispatch must not rely on the in-memory fallback queue. When false,
   * a running task that cannot be intervened returns an explicit deferred result so
   * the caller can keep its durable store active and retry later.
   */
  queueIfRunning?: boolean;
}

/**
 * `addIntervention`의 auto-resume 경로 콜백.
 *
 * Task가 completed/error/interrupted일 때 route는 status를 "running"으로 돌리는
 * transition에 본 콜백을 넘긴다. 콜백은 *task_executor.startExecution*을 호출할 책임.
 * design-principles §1(지식 경계) — task route는 executor를 알지 않는다.
 */
export type StartExecutionCallback = AutoResumeCallback;

export interface TaskInterventionRouteDeps {
  getTask(sessionId: string): Task | undefined;
  loadEvictedTask(sessionId: string): Promise<Task | null>;
  rememberTask(task: Task): void;
  runningInterventionTransition: Pick<
    RunningInterventionTransition,
    "deliver" | "queueOnly"
  >;
  autoResumeTransition: Pick<AutoResumeTransition, "resume">;
  deliveryLedgerGate?: Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult" | "recordFailure"
      | "recordNotificationPublished" | "recordNotificationFailure"
      | "recordReservationRetry"
  > & Partial<Pick<TaskDeliveryLedgerGate, "reserveRetry">>;
  sessionNotificationPublisher?: Pick<SessionNotificationPublisher, "publish">;
}

/**
 * Owns public intervention route policy.
 *
 * Active status is the single authority for routing an intervention to the
 * attached runner. RunningInterventionTransition and AutoResumeTransition own
 * side-effect order. This route owns task resolution, transition selection,
 * public result forwarding, and onResume callback wiring.
 */
export class TaskInterventionRoute {
  constructor(private readonly deps: TaskInterventionRouteDeps) {}

  async addIntervention(
    params: AddInterventionParams,
    onResume: StartExecutionCallback,
  ): Promise<AddInterventionResult> {
    const request = this.deps.deliveryLedgerGate
      ? ensureHumanDeliveryIdentity(params)
      : params;
    // Every session-directed message enters through the same ownership check.
    // Producer intent affects durable identity and notification projection only,
    // never whether an active conversation hears the message.
    const task = await this.resolveTask(params.agentSessionId);
    const admission = this.deps.deliveryLedgerGate
      ? await this.deps.deliveryLedgerGate.admit(request)
      : { kind: "legacy" } as const;
    const initialMessage: InterventionMessage = {
      text: request.text,
      user: request.user,
      callerInfo: request.callerInfo,
      attachmentPaths: request.attachmentPaths,
      context: request.context,
      source: request.source,
      deliveryId: request.deliveryId,
      deliveryIntent: request.deliveryIntent,
      completionId: request.completionId,
      relationKey: request.relationKey,
      producerTerminalRevision: request.producerTerminalRevision,
      parentDeliveryId: request.parentDeliveryId,
      callerTurnId: request.callerTurnId,
      deliveryCreatedAt: request.deliveryCreatedAt,
      deliveryLeaseOwner: request.deliveryLeaseOwner,
      followupAttempt: request.followupAttempt,
      followupKey: request.followupKey,
      followupTaskIds: request.followupTaskIds,
      storedDeliveryPayload: request.storedDeliveryPayload,
      storedDeliveryPayloadHash: request.storedDeliveryPayloadHash,
    };
    if (admission.kind === "suppressed") {
      return {
        suppressed: true,
        deliveryId: admission.deliveryId,
        reason: admission.reason,
      };
    }
    const message = admission.kind === "admitted"
      ? hydrateStoredDeliveryMessage(initialMessage, admission.row)
      : initialMessage;

    let ledgerResultRecorded = false;
    let deferredResume: { task: Task; activation?: Task["executionActivation"] } | undefined;
    let deferredResumeStarted = false;
    let activationCompleted = false;
    let notificationDisposition: "queued" | "auto_resume" | undefined;
    let notificationPublication: NotificationPublication | undefined;
    const startDeferredResumeOnce = (): void => {
      if (deferredResumeStarted || !deferredResume) return;
      deferredResumeStarted = true;
      const resume = deferredResume;
      deferredResume = undefined;
      onResume(resume.task, resume.activation);
    };
    try {
      await this.awaitInitializingTask(task);
      if (this.deps.deliveryLedgerGate) {
        const rechecked = await this.deps.deliveryLedgerGate.beginDispatch(
          admission,
        );
        if (rechecked.kind === "suppressed") {
          return {
            suppressed: true,
            deliveryId: rechecked.deliveryId,
            reason: rechecked.reason,
          };
        }
      }
      const taskRoute = interventionTaskRoute(task);
      if (taskRoute === "activating") {
        throw new Error(
          `execution activation did not reach running state for ${task.agentSessionId}`,
        );
      }
      const isRunning = taskRoute === "running";
      const heldHumanRetry = admission.kind === "admitted"
        && admission.row.intent === "human_live_steer"
        && hasPriorDispatchAttempt(admission.row);
      let result: AddInterventionResult;
      if (isRunning) {
        result = heldHumanRetry
          ? await this.deps.runningInterventionTransition.queueOnly(task, message)
          : await this.deps.runningInterventionTransition.deliver(task, message, {
              queueIfUndelivered: request.queueIfRunning ?? true,
            });
        if (
          admission.kind === "admitted"
          && isNotificationDeliveryIntent(admission.row.intent)
          && "queued" in result
          && result.queued
        ) {
          notificationDisposition = "queued";
        }
      } else if (heldHumanRetry) {
        result = await this.deps.runningInterventionTransition.queueOnly(task, message);
      } else if (
        isTerminalTaskStatus(task.status)
        && admission.kind === "admitted"
        && admission.row.intent === "completion_notification"
      ) {
        result = {
          delivered: false,
          queued: true,
          queuePosition: 1,
          consumeWhen: "next_turn",
          reason: "queue_only_policy",
        };
        notificationDisposition = "queued";
      } else if (admission.kind === "admitted") {
        const deferResumeUntilQueued: StartExecutionCallback = (resumedTask, activation) => {
          deferredResume = { task: resumedTask, activation };
        };
        result = await this.deps.autoResumeTransition.resume(
          task,
          message,
          deferResumeUntilQueued,
          ...(admission.row.attempt_count > 0
            ? [{ publishUserMessage: false }]
            : []),
        );
      } else {
        result = await this.deps.autoResumeTransition.resume(task, message, onResume);
      }
      if (
        admission.kind === "admitted"
        && isNotificationDeliveryIntent(admission.row.intent)
        && "autoResumed" in result
      ) {
        notificationDisposition = "auto_resume";
      }
      if (this.deps.deliveryLedgerGate) {
        await this.deps.deliveryLedgerGate.recordResult(
          admission,
          result,
        );
        ledgerResultRecorded = true;
      }
      if (notificationDisposition && this.deps.sessionNotificationPublisher) {
        notificationPublication = await this.deps.sessionNotificationPublisher.publish(
          task,
          message,
          notificationDisposition,
        );
        if (notificationDisposition !== "auto_resume") {
          await this.projectNotificationPublication(
            admission,
            notificationPublication,
          );
        }
      }
      // A terminal delivery must exist durably in `queued` before the executor
      // can dequeue it. A worker crash before this callback is recoverable from
      // the ledger; starting first would leave a running task with no receipt.
      startDeferredResumeOnce();
      if ("autoResumed" in result && task.status === "initializing") {
        const activation = task.executionActivation?.promise;
        if (!activation) {
          throw new Error(
            `auto-resume executor did not expose activation barrier for ${task.agentSessionId}`,
          );
        }
        await activation;
      }
      activationCompleted = true;
      if (notificationDisposition === "auto_resume" && notificationPublication) {
        await this.projectNotificationPublication(admission, notificationPublication);
      }
      return result;
    } catch (err) {
      let recoveryError: unknown;
      try {
        startDeferredResumeOnce();
      } catch (resumeError) {
        recoveryError = resumeError;
      }
      if (
        this.deps.deliveryLedgerGate
        && ledgerResultRecorded
        && notificationDisposition === "auto_resume"
        && !activationCompleted
      ) {
        try {
          await this.deps.deliveryLedgerGate.recordNotificationFailure?.(
            admission,
            `auto-resume activation failed: ${errorMessage(err)}`,
          );
        } catch (notificationRecoveryError) {
          recoveryError ??= notificationRecoveryError;
        }
      }
      if (
        this.deps.deliveryLedgerGate
        && isExecutionOwnershipConflictError(err)
      ) {
        const disposition = await this.deps.deliveryLedgerGate.recordReservationRetry(
          admission,
          err.retryAt,
        );
        if (disposition === "scheduled" || disposition === "parked") {
          return {
            delivered: false,
            queued: true,
            queuePosition: 1,
            consumeWhen: "next_turn",
            reason: "queue_only_policy",
          };
        }
      }
      if (this.deps.deliveryLedgerGate && !ledgerResultRecorded) {
        try {
          await this.deps.deliveryLedgerGate.recordFailure(admission);
        } catch (recordFailureError) {
          recoveryError ??= recordFailureError;
        }
      }
      if (recoveryError && err instanceof Error && err.cause === undefined) {
        err.cause = recoveryError;
      }
      throw err;
    }
  }

  /** Persist a delayed retry reservation; this is not a conversation entry. */
  async reserveDeliveryRetry(
    params: AddInterventionParams,
    deliveryNextAttemptAt: string,
  ): Promise<void> {
    if (!this.deps.deliveryLedgerGate) return;
    await this.resolveTask(params.agentSessionId);
    const admission = await this.deps.deliveryLedgerGate.admit(params);
    const reserveRetry = this.deps.deliveryLedgerGate.reserveRetry;
    if (!reserveRetry) {
      throw new Error("Delivery retry reservation capability is unavailable");
    }
    await reserveRetry.call(
      this.deps.deliveryLedgerGate,
      admission,
      deliveryNextAttemptAt,
    );
  }

  private async awaitInitializingTask(task: Task): Promise<void> {
    if (task.status !== "initializing") return;
    const activation = task.executionActivation?.promise;
    if (!activation) {
      throw new Error(
        `initializing task has no activation barrier: ${task.agentSessionId}`,
      );
    }
    await activation;
  }

  private async projectNotificationPublication(
    admission: DeliveryLedgerAdmission,
    publication: NotificationPublication,
  ): Promise<void> {
    if (!this.deps.deliveryLedgerGate) return;
    if (publication.published) {
      await this.deps.deliveryLedgerGate.recordNotificationPublished?.(
        admission,
        publication.targetReceiptId,
      );
      return;
    }
    await this.deps.deliveryLedgerGate.recordNotificationFailure?.(
      admission,
      "session_notification persistence failed",
    );
  }

  private async resolveTask(agentSessionId: string): Promise<Task> {
    const activeTask = this.deps.getTask(agentSessionId);
    if (activeTask) return activeTask;

    const loaded = await this.deps.loadEvictedTask(agentSessionId);
    if (!loaded) {
      throw new Error(`Task not found: ${agentSessionId}`);
    }
    this.deps.rememberTask(loaded);
    return loaded;
  }
}

function hasPriorDispatchAttempt(row: SessionDeliveryRow): boolean {
  return row.attempt_count > 0
    || Boolean(row.dispatching_at)
    || Boolean(row.queued_at);
}

function interventionTaskRoute(
  task: Task,
): "running" | "activating" | "auto-resume" {
  if (task.status === "initializing") return "activating";
  if (!isActiveTaskStatus(task.status)) return "auto-resume";
  return task.runner === undefined || task.runner.dispatcher.hasActiveExecution()
    ? "running"
    : "auto-resume";
}

export function ensureHumanDeliveryIdentity(
  params: AddInterventionParams,
): AddInterventionParams {
  if (params.deliveryIntent) return params;
  const deliveryId = randomUUID();
  return {
    ...params,
    source: params.source ?? "user_message",
    deliveryId,
    deliveryIntent: "human_live_steer",
    completionId: `message:${deliveryId}`,
    relationKey: `user_message:${params.agentSessionId}:${deliveryId}`,
    deliveryCreatedAt: new Date().toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hydrateStoredDeliveryMessage(
  message: InterventionMessage,
  row: SessionDeliveryRow,
): InterventionMessage {
  const canonical = readCanonicalDeliveryPayload(row.payload);
  return {
    ...message,
    text: canonical.text,
    user: canonical.user,
    callerInfo: canonical.callerInfo,
    attachmentPaths: canonical.attachmentPaths,
    context: canonical.context,
    followupKey: canonical.followupKey,
    followupAttempt: canonical.followupAttempt,
    followupTaskIds: canonical.followupTaskIds,
    source: row.source,
    deliveryId: row.delivery_id,
    deliveryIntent: row.intent,
    completionId: row.completion_id ?? undefined,
    relationKey: row.relation_key,
    producerTerminalRevision: row.producer_terminal_revision ?? undefined,
    parentDeliveryId: row.parent_delivery_id ?? undefined,
    callerTurnId: row.caller_turn_id ?? undefined,
    deliveryCreatedAt: row.created_at.toISOString(),
    deliveryLeaseOwner: row.lease_owner ?? undefined,
    storedDeliveryPayload: row.payload,
    storedDeliveryPayloadHash: row.payload_hash,
  };
}
