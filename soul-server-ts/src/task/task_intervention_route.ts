import type { AutoResumeCallback, AutoResumeTransition } from "./task_auto_resume_transition.js";
import type { ActiveTaskRecovery } from "./task_active_recovery.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { SessionDeliveryRow } from "../db/session_db_types.js";
import {
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
import { decideNotificationDelivery } from "./delivery_policy.js";
import { readCanonicalDeliveryPayload } from "./delivery_payload.js";
import type { SessionNotificationPublisher } from "./task_session_notification.js";

/**
 * `addIntervention` 결과. Python `task_manager.add_intervention` L590-595 정본 형상.
 *
 * - running 세션 → `engine.intervene()`가 현재 전달하면 `{delivered: true}`,
 *   전달하지 못하면 소비 시점과 사유가 명시된 queue/defer 결과.
 * - completed/error/interrupted → `{autoResumed: true}` — task_executor.startExecution이
 *   resumeSessionId(task.codexThreadId)로 다음 turn 자동 시작.
 */
export type AddInterventionResult =
  | RunningInterventionResult
  | { autoResumed: true }
  | {
      delivered: false;
      deferred: true;
      retryWhen: "terminal_state";
      reason: "terminal_only_policy";
    }
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
  /** Durable delayed retry due time. Internal ledger scheduling metadata. */
  deliveryNextAttemptAt?: string;
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
  /** Delayed retries must use the terminal auto-resume path, never live steering. */
  onlyIfTerminal?: boolean;
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
  activeTaskRecovery: Pick<ActiveTaskRecovery, "prepareForIntervention">;
  runningInterventionTransition: Pick<
    RunningInterventionTransition,
    "deliver" | "queueOnly"
  >;
  autoResumeTransition: Pick<AutoResumeTransition, "resume">;
  deliveryLedgerGate?: Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult" | "recordFailure"
      | "recordNotificationPublished" | "recordNotificationFailure"
  >;
  sessionNotificationPublisher?: Pick<SessionNotificationPublisher, "publish">;
}

/**
 * Owns public intervention route policy.
 *
 * ActiveTaskRecovery owns stale-running classification. RunningInterventionTransition and
 * AutoResumeTransition own side-effect order. This route owns task resolution, transition
 * selection, public result forwarding, and onResume callback wiring.
 */
export class TaskInterventionRoute {
  constructor(private readonly deps: TaskInterventionRouteDeps) {}

  async addIntervention(
    params: AddInterventionParams,
    onResume: StartExecutionCallback,
  ): Promise<AddInterventionResult> {
    const initialMessage: InterventionMessage = {
      text: params.text,
      user: params.user,
      callerInfo: params.callerInfo,
      attachmentPaths: params.attachmentPaths,
      context: params.context,
      source: params.source,
      deliveryId: params.deliveryId,
      deliveryIntent: params.deliveryIntent,
      completionId: params.completionId,
      relationKey: params.relationKey,
      producerTerminalRevision: params.producerTerminalRevision,
      parentDeliveryId: params.parentDeliveryId,
      callerTurnId: params.callerTurnId,
      deliveryCreatedAt: params.deliveryCreatedAt,
      deliveryLeaseOwner: params.deliveryLeaseOwner,
      followupAttempt: params.followupAttempt,
      followupKey: params.followupKey,
      followupTaskIds: params.followupTaskIds,
      storedDeliveryPayload: params.storedDeliveryPayload,
      storedDeliveryPayloadHash: params.storedDeliveryPayloadHash,
    };
    const admission: DeliveryLedgerAdmission = this.deps.deliveryLedgerGate
      ? await this.deps.deliveryLedgerGate.admit(params)
      : { kind: "legacy" };
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

    let task: Task | undefined;
    let ledgerResultRecorded = false;
    let deferredResumeTask: Task | undefined;
    let deferredResumeStarted = false;
    const startDeferredResumeOnce = (): void => {
      if (deferredResumeStarted || !deferredResumeTask) return;
      deferredResumeStarted = true;
      const resumedTask = deferredResumeTask;
      deferredResumeTask = undefined;
      onResume(resumedTask);
    };
    try {
      task = await this.resolveTask(params.agentSessionId);
      if (params.onlyIfTerminal === true && !isTerminalTaskStatus(task.status)) {
        const result = {
          delivered: false,
          deferred: true,
          retryWhen: "terminal_state",
          reason: "terminal_only_policy",
        } as const;
        if (this.deps.deliveryLedgerGate) {
          await this.deps.deliveryLedgerGate.recordResult(
            admission,
            result,
            params.deliveryNextAttemptAt,
          );
        }
        return result;
      }
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
      const isRunning =
        this.deps.activeTaskRecovery.prepareForIntervention(task) === "running";
      const notificationDecision =
        admission.kind === "admitted" &&
        isNotificationIntent(message.deliveryIntent)
          ? decideNotificationDelivery(
              "pending",
              isRunning ? "generating" : "terminal",
            )
          : undefined;
      let result: AddInterventionResult;
      let notificationDisposition: "queued" | "auto_resume" | undefined;
      if (isRunning && admission.kind === "admitted") {
        if (notificationDecision?.action === "queue_only") {
          result = await this.deps.runningInterventionTransition.queueOnly(
            task,
            message,
            { publishEvent: false },
          );
          notificationDisposition = "queued";
        } else {
          result = await this.deps.runningInterventionTransition.queueOnly(task, message);
        }
      } else if (isRunning) {
        result = await this.deps.runningInterventionTransition.deliver(task, message, {
          queueIfUndelivered: params.queueIfRunning ?? true,
        });
      } else if (admission.kind === "admitted") {
        const deferResumeUntilQueued: StartExecutionCallback = (resumedTask) => {
          deferredResumeTask = resumedTask;
        };
        if (notificationDecision?.action === "resume_next_turn") {
          result = await this.deps.autoResumeTransition.resume(
            task,
            message,
            deferResumeUntilQueued,
            { publishUserMessage: false },
          );
          notificationDisposition = "auto_resume";
        } else {
          result = await this.deps.autoResumeTransition.resume(
            task,
            message,
            deferResumeUntilQueued,
          );
        }
      } else {
        result = await this.deps.autoResumeTransition.resume(task, message, onResume);
      }
      if (this.deps.deliveryLedgerGate) {
        await this.deps.deliveryLedgerGate.recordResult(
          admission,
          result,
          params.deliveryNextAttemptAt,
        );
        ledgerResultRecorded = true;
      }
      if (notificationDisposition && this.deps.sessionNotificationPublisher) {
        const published = await this.deps.sessionNotificationPublisher.publish(
          task,
          message,
          notificationDisposition,
        );
        if (this.deps.deliveryLedgerGate) {
          if (published.published) {
            await this.deps.deliveryLedgerGate.recordNotificationPublished?.(
              admission,
              published.targetReceiptId,
            );
          } else {
            await this.deps.deliveryLedgerGate.recordNotificationFailure?.(
              admission,
              "session_notification persistence failed",
            );
          }
        }
      }
      // A terminal delivery must exist durably in `queued` before the executor
      // can dequeue it. A worker crash before this callback is recoverable from
      // the ledger; starting first would leave a running task with no receipt.
      startDeferredResumeOnce();
      return result;
    } catch (err) {
      let recoveryError: unknown;
      try {
        startDeferredResumeOnce();
      } catch (resumeError) {
        recoveryError = resumeError;
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

function isNotificationIntent(
  intent: DeliveryIntent | undefined,
): intent is "completion_notification" | "runtime_followup" {
  return intent === "completion_notification" || intent === "runtime_followup";
}
