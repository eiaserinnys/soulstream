/**
 * TaskManager — 세션 task 컬렉션 관리 (Phase B-3 기본 + B-4 intervention).
 *
 * Python `service/task_manager.py`의 *codex 적응판*. session_eviction은 본 PR 범위 외
 * (codex MVP).
 *
 * 책임:
 *   - createTask: Task 생성 + host `register_session` + broadcast `session_created`
 *   - getTask / listTasks
 *   - cancelTask: 진행 중 turn abort
 *   - deleteTask: 메모리 + host `delete_session` + broadcast `session_deleted`
 *   - addIntervention (B-4): turn 사이 큐잉 또는 auto-resume — 분석 캐시
 *     `20260517-1410-codex-ts-folder-resume-intervene.md` §D
 *
 * 본 PR은 *task lifecycle 메타 관리*만. 실제 *engine 실행*은 TaskExecutor 책임.
 */

import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { BoardYjsHostClient } from "../collaboration/board_yjs_host_client.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { AcknowledgeReviewOutcome, SessionDB } from "../db/session_db.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { ClaudeSessionRuntimeControl } from "../engine/claude_session_client_registry.js";
import {
  createMissingSessionMutationHost,
  type SessionMutationHost,
} from "../control_plane/persistence_host_clients.js";

import type { Task, TaskStatus } from "./task_models.js";
import { ActiveTaskRecovery } from "./task_active_recovery.js";
import { AutoResumeTransition } from "./task_auto_resume_transition.js";
import { createEvictedTaskLoader } from "./task_evicted_hydration.js";
import { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import { TaskRunnerRecovery } from "./task_runner_recovery.js";
import {
  TaskLifecycleRoute,
  type FinalizeTaskParams,
} from "./task_lifecycle_route.js";
import { ToolApprovalRecovery } from "./task_tool_approval_recovery.js";
import { RunningInterventionTransition } from "./task_running_intervention_transition.js";
import { TaskCreation, type CreateTaskParams } from "./task_creation.js";
import type { TaskCreationHook } from "./task_creation_hook.js";
import {
  TaskDeliveryRoute,
  type DeliverInputResponseParams,
  type DeliverInputResponseResult,
  type DeliverToolApprovalParams,
  type DeliverToolApprovalResult,
} from "./task_delivery_route.js";
import {
  TaskInterventionRoute,
  type AddInterventionParams,
  type AddInterventionResult,
  type StartExecutionCallback,
} from "./task_intervention_route.js";
import { ResponseEventPublisher } from "./task_response_event_publisher.js";
import { TaskDeliveryLedgerGate } from "./task_delivery_ledger_gate.js";
import { SessionNotificationPublisher } from "./task_session_notification.js";
import { SessionDeliveryNotificationRecovery } from "./session_delivery_notification_recovery.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import {
  type ClaudeRuntimeBackgroundTasksResult,
  type ClaudeRuntimeTaskListResult,
  type ClaudeRuntimeTaskOutputResult,
  type ClaudeRuntimeTaskStopResult,
} from "./claude_runtime_control.js";
import { TaskClaudeRuntimeControlRoute } from "./task_claude_runtime_control_route.js";
import { resolveModelPresetSelection } from "./task_model_preset.js";
import { resolveSourceTaskItemProvenance } from "./source_task_item_provenance.js";

export type { CreateTaskParams } from "./task_creation.js";
export type {
  DeliverInputResponseParams,
  DeliverInputResponseResult,
  DeliverInputResponseStatus,
  DeliverToolApprovalParams,
  DeliverToolApprovalResult,
  DeliverToolApprovalStatus,
} from "./task_delivery_route.js";
export type {
  AddInterventionParams,
  AddInterventionResult,
  StartExecutionCallback,
} from "./task_intervention_route.js";
export type { FinalizeTaskParams } from "./task_lifecycle_route.js";

export class TaskManager {
  private readonly tasks = new Map<string, Task>();
  private readonly taskCreation: TaskCreation;
  private readonly toolApprovalRecovery: ToolApprovalRecovery;
  private readonly responseEventPublisher: ResponseEventPublisher;
  private readonly deliveryRoute: TaskDeliveryRoute;
  private readonly interventionRoute: TaskInterventionRoute;
  private readonly lifecycleRoute: TaskLifecycleRoute;
  private readonly deliveryLedgerGate: TaskDeliveryLedgerGate;
  private readonly deliveryNotificationRecovery?: SessionDeliveryNotificationRecovery;
  private readonly sessionNotificationPublisher: SessionNotificationPublisher;
  private readonly claudeRuntimeControlRoute: TaskClaudeRuntimeControlRoute;
  private readonly loadEvictedTask: (sessionId: string) => Promise<Task | null>;
  private readonly sessionMutations: SessionMutationHost;
  private readonly runnerRecovery: TaskRunnerRecovery;

  constructor(
    private readonly nodeId: string,
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
    private readonly logger: Logger,
    /** Persistent publisher의 durable outbox ingress. 누락 시 발행 경로가 명시적으로 실패한다. */
    persistence?: EventPersistence,
    /**
     * Phase A context 정본 진입점 (atom d7a1ad86 차단):
     * auto-resume transition이 user_message wire에 박을 ContextItem[]을 조립할 때 사용.
     * undefined일 때 context 박지 않음 (legacy 호출자·단위 테스트 호환 — design-principles §8 실패 격리).
     */
    contextBuilder?: ExecutionContextBuilder,
    private readonly agentRegistry?: AgentRegistry,
    private readonly boardYjsService?: Pick<BoardYjsHostClient, "upsertSessionBoardItem">,
    taskCreationHook?: TaskCreationHook,
    private readonly deliveryRuntimeV2Enabled = false,
    sessionRuntimeControl?: ClaudeSessionRuntimeControl,
    private readonly modelCatalog?: Pick<ModelCatalog, "resolve">,
    sessionMutations?: SessionMutationHost,
  ) {
    this.sessionMutations = sessionMutations ?? createMissingSessionMutationHost();
    this.loadEvictedTask = createEvictedTaskLoader({ db, logger, nodeId });
    const gatedSessionRuntimeControl = deliveryRuntimeV2Enabled
      ? sessionRuntimeControl
      : undefined;
    this.taskCreation = new TaskCreation({
      nodeId: this.nodeId,
      db,
      sessionMutations: this.sessionMutations,
      persistence,
      boardYjsService,
      broadcaster,
      logger,
      taskCreationHook,
      hasTask: (sessionId) => this.tasks.has(sessionId),
      rememberTask: (task) => {
        this.tasks.set(task.agentSessionId, task);
      },
    });
    const lifecycleTransition = new TaskLifecycleTransition({
      logger,
      persistence,
    });
    this.lifecycleRoute = new TaskLifecycleRoute({
      getTask: (sessionId) => this.tasks.get(sessionId),
      listTasks: () => Array.from(this.tasks.values()),
      forgetTask: (sessionId) => {
        this.tasks.delete(sessionId);
      },
      lifecycleTransition,
      sessionMutations: this.sessionMutations,
      broadcaster,
      logger,
      closeSessionRuntime: gatedSessionRuntimeControl
        ? (sessionId, reason) => gatedSessionRuntimeControl.close(sessionId, reason)
        : undefined,
    });
    const activeTaskRecovery = new ActiveTaskRecovery(logger);
    const runningInterventionTransition = new RunningInterventionTransition({
      broadcaster,
      logger,
      persistence,
    });
    const autoResumeTransition = new AutoResumeTransition({
      logger,
      persistence,
      contextBuilder,
      agentRegistry,
    });
    this.runnerRecovery = new TaskRunnerRecovery({
      getTask: (sessionId) => this.tasks.get(sessionId),
      loadTask: (sessionId) => this.loadEvictedTask(sessionId),
      rememberTask: (task) => this.tasks.set(task.agentSessionId, task),
      lifecycleTransition,
      autoResumeTransition,
    });
    const deliveryRepository = deliveryRuntimeV2Enabled
      ? db.sessionDeliveries()
      : undefined;
    this.deliveryLedgerGate = new TaskDeliveryLedgerGate(
      deliveryRuntimeV2Enabled,
      deliveryRepository,
    );
    this.sessionNotificationPublisher = new SessionNotificationPublisher({
      broadcaster,
      logger,
      persistence,
    });
    this.deliveryNotificationRecovery =
      deliveryRuntimeV2Enabled && deliveryRepository
        ? new SessionDeliveryNotificationRecovery({
            repository: deliveryRepository.notifications,
            publish: (task, message, disposition) =>
              this.sessionNotificationPublisher.publish(task, message, disposition),
            resolveTask: (sessionId) => this.resolveNotificationTask(sessionId),
            targetNodeId: nodeId,
            logger,
          })
        : undefined;
    this.responseEventPublisher = new ResponseEventPublisher({
      broadcaster,
      logger,
      persistence,
    });
    this.toolApprovalRecovery = new ToolApprovalRecovery({
      getTask: (sessionId) => this.tasks.get(sessionId),
      loadEvictedTask: (sessionId) => this.loadEvictedTask(sessionId),
      rememberTask: (task) => {
        this.tasks.set(task.agentSessionId, task);
      },
      persistToolApprovalResolved: (task, params) =>
        this.responseEventPublisher.publishToolApprovalResolved(task, params),
      emitSessionUpdated: (task) => this.broadcaster.emitSessionUpdated(task),
      logger,
    });
    this.deliveryRoute = new TaskDeliveryRoute({
      getTask: (sessionId) => this.tasks.get(sessionId),
      toolApprovalRecovery: this.toolApprovalRecovery,
      responseEventPublisher: this.responseEventPublisher,
      agentRegistry,
      sessionRuntimeControl: gatedSessionRuntimeControl,
    });
    this.claudeRuntimeControlRoute = new TaskClaudeRuntimeControlRoute({
      db,
      getTask: (sessionId) => this.tasks.get(sessionId),
      sessionRuntimeControl: gatedSessionRuntimeControl,
    });
    this.interventionRoute = new TaskInterventionRoute({
      getTask: (sessionId) => this.tasks.get(sessionId),
      loadEvictedTask: (sessionId) => this.loadEvictedTask(sessionId),
      rememberTask: (task) => {
        this.tasks.set(task.agentSessionId, task);
      },
      activeTaskRecovery,
      runningInterventionTransition,
      autoResumeTransition,
      deliveryLedgerGate: deliveryRuntimeV2Enabled ? this.deliveryLedgerGate : undefined,
      sessionNotificationPublisher: deliveryRuntimeV2Enabled
        ? this.sessionNotificationPublisher
        : undefined,
    });
  }

  /**
   * 새 Task 생성 + host 등록 + orch broadcast. 신규 task creation policy는
   * TaskCreation이 소유하고, TaskManager는 public collection API를 유지한다.
   */
  async createTask(params: CreateTaskParams): Promise<Task> {
    const sourceTaskItemId = await resolveSourceTaskItemProvenance({
      sessionId: params.agentSessionId,
      sourceTaskItemId: params.sourceTaskItemId,
      container: params.container,
      getTaskSnapshot: (taskId) => this.db.getTaskSnapshot(taskId),
      logger: this.logger,
    });
    const resolvedParams = { ...params, sourceTaskItemId };
    const agent = resolvedParams.profileId
      ? this.agentRegistry?.get(resolvedParams.profileId)
      : undefined;
    const canonicalParams = agent && resolvedParams.profileId !== agent.id
      ? { ...resolvedParams, profileId: agent.id }
      : resolvedParams;
    if (!agent || resolvedParams.modelPresetBackend) {
      return await this.taskCreation.createTask(canonicalParams);
    }

    const preset = resolveModelPresetSelection(canonicalParams, agent, this.modelCatalog);
    if (!preset) {
      return await this.taskCreation.createTask(canonicalParams);
    }
    return await this.taskCreation.createTask({
      ...canonicalParams,
      model: preset.model,
      modelPreset: preset.id,
      modelPresetBackend: preset.backend,
      modelPresetEnv: preset.env,
    });
  }

  getTask(sessionId: string): Task | undefined {
    return this.tasks.get(sessionId);
  }

  async hydrateRunnerRecoveryTask(sessionId: string): Promise<Task | null> {
    return await this.runnerRecovery.hydrate(sessionId);
  }

  async markRunnerFailureAndResume(
    task: Task,
    message: string,
    onResume: StartExecutionCallback,
  ): Promise<void> {
    await this.runnerRecovery.markFailureAndResume(task, message, onResume);
  }

  getDeliveryConsumptionRecorder(): Pick<
    TaskDeliveryLedgerGate,
    "recordConsumed" | "recordTurnStarted"
      | "recordInlineConsumed"
  > | undefined {
    return this.deliveryRuntimeV2Enabled ? this.deliveryLedgerGate : undefined;
  }

  listTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  async recoverDeliveryNotifications(
    leaseOwner: string,
    limit = 100,
  ): Promise<number> {
    return await this.deliveryNotificationRecovery?.recover(leaseOwner, limit) ?? 0;
  }

  async listClaudeRuntimeTasks(sessionId: string): Promise<ClaudeRuntimeTaskListResult> {
    return await this.claudeRuntimeControlRoute.list(sessionId);
  }

  async getClaudeRuntimeTaskOutput(
    sessionId: string,
    taskId: string,
  ): Promise<ClaudeRuntimeTaskOutputResult> {
    return await this.claudeRuntimeControlRoute.output(sessionId, taskId);
  }

  async stopClaudeRuntimeTask(
    sessionId: string,
    taskId: string,
  ): Promise<ClaudeRuntimeTaskStopResult> {
    return await this.claudeRuntimeControlRoute.stopClaudeRuntimeTask(
      sessionId,
      taskId,
    );
  }

  async backgroundClaudeRuntimeTasks(
    sessionId: string,
    toolUseId?: string,
  ): Promise<ClaudeRuntimeBackgroundTasksResult> {
    return await this.claudeRuntimeControlRoute.backgroundClaudeRuntimeTasks(
      sessionId,
      toolUseId,
    );
  }

  /**
   * AskUserQuestion/input_request 응답 전달.
   *
   * Delivery route policy는 TaskDeliveryRoute가 소유한다. TaskManager는 기존 public
   * API 표면을 유지하는 wrapper다.
   */
  async deliverInputResponse(
    params: DeliverInputResponseParams,
  ): Promise<DeliverInputResponseResult> {
    return await this.deliveryRoute.deliverInputResponse(params);
  }

  /**
   * Agents SDK tool approval 전달.
   *
   * AskUserQuestion/respond와 별도 capability로 분리한다. `respond`는 Claude
   * input_request에만 대응하고, `approve_tool`/`reject_tool`은 Agents SDK
   * RunToolApprovalItem interruption에만 대응한다. Delivery route policy는
   * TaskDeliveryRoute가 소유한다.
   */
  async deliverToolApproval(
    params: DeliverToolApprovalParams,
    onResume?: StartExecutionCallback,
  ): Promise<DeliverToolApprovalResult> {
    return await this.deliveryRoute.deliverToolApproval(params, onResume);
  }

  /**
   * 진행 중 turn abort. Runtime v2에서는 terminal Task의 남은 session runtime도 회수.
   * 성공 시 status=interrupted로 전환. 없으면 false.
   *
   * code-reviewer P1 정정: status="interrupted" 박힘은 *여기서* 책임진다.
   * adapter abort catch는 yield 없이 generator를 정상 종료 — task_executor의
   * 정상 종료 분기 `if (task.status === "running") task.status = "completed"`가
   * interrupt 경로에도 발동되어 wire가 "completed"로 박히는 결함을 차단.
   *
   * 본 메서드가 status를 *engine.interrupt 호출 전*에 박으므로, 그 후 generator가
   * 정상 종료해도 _consumeEventStream의 가드가 status를 덮지 않는다.
   * terminal event의 terminal_transition effect가 interrupted 상태를 원자 반영한다.
   */
  async cancelTask(sessionId: string): Promise<boolean> {
    return await this.lifecycleRoute.cancelTask(sessionId);
  }

  /**
   * Task 제거. 메모리 + DB + broadcast.
   * 진행 중이면 cancel 후 promise drain 대기.
   */
  async deleteTask(sessionId: string): Promise<void> {
    await this.lifecycleRoute.deleteTask(sessionId);
  }

  /**
   * 모든 진행 중 task 정지 + drain. shutdown 시 호출.
   * 종료 신호 직후 DB 상태를 terminal로 먼저 기록한다. 프로세스 재시작이 drain보다
   * 먼저 완료되어도 대시보드에 stale running 세션이 남지 않아야 한다.
   */
  async shutdown(): Promise<void> {
    await this.lifecycleRoute.shutdown();
  }

  /** 내부 상태 변경 helper (task_executor용). */
  setTaskStatus(sessionId: string, status: TaskStatus): void {
    const task = this.tasks.get(sessionId);
    if (task) task.status = status;
  }

  /**
   * 외부 실행기(LLM proxy 등)가 만든 task를 완료/실패 상태로 마무리한다.
   *
   * TaskExecutorFinalizer는 engine lifecycle까지 닫는 전용 경로라 LLM proxy에서 재사용할 수 없다.
   * 이 메서드는 세션 상태·완료 시각·LLM usage를 terminal event effect로 원자 반영한다.
   */
  async finalizeTask(params: FinalizeTaskParams): Promise<Task | undefined> {
    return await this.lifecycleRoute.finalizeTask(params);
  }

  async acknowledgeReview(sessionId: string): Promise<AcknowledgeReviewOutcome> {
    let task: Task | null | undefined = this.tasks.get(sessionId);
    if (!task) {
      try {
        task = await this.loadEvictedTask(sessionId);
      } catch (err) {
        this.logger.warn({ err, sessionId }, "runtime review state unavailable before acknowledge");
      }
    }
    const outcome = await this.sessionMutations.acknowledgeReview(
      sessionId,
      `acknowledge_review:${sessionId}:${task?.lastEventId ?? 0}`,
    );
    if (outcome !== "acknowledged" && outcome !== "already_acknowledged") {
      return outcome;
    }

    if (!task) {
      this.logger.warn(
        { sessionId, outcome },
        "runtime review repair missing task after durable acknowledge",
      );
      return outcome;
    }
    task.reviewState = "acknowledged";
    try {
      await this.broadcaster.emitSessionUpdated(task);
    } catch (err) {
      this.logger.warn({ err, sessionId }, "session_updated review acknowledge broadcast failed");
    }
    return outcome;
  }

  /**
   * Turn 사이 개입 메시지 추가 (B-4, 분석 캐시
   * `20260517-1410-codex-ts-folder-resume-intervene.md` §D-3).
   *
 * Python `service/task_manager.py:563-642 add_intervention` 정본의 codex 적응판.
 *
 * 분기:
 *   - Running: `EnginePort.intervene()`가 백엔드별 전달 방식을 감춘다.
 *     현재 전달하면 `{delivered: true}`, 지금 전달할 수 없으면 사유와 다음 소비 시점을
 *     포함한 queue/defer 결과를 반환한다.
   *   - Completed/Error/Interrupted: user_message를 박고 status를 "running"으로 돌린 뒤
   *     queue push + session_updated + onResume 콜백 호출 → `{autoResumed}`. 콜백은 호출자가
   *     task_executor.startExecution을 호출하도록 제공. design-principles §1(지식 경계) —
   *     task_manager는 executor를 import하지 않는다.
   *   - 미존재 task: `Error` throw — 호출자(dispatcher)가 sendError로 변환.
   *
   * 단일 process·단일 task Map이라 mutex 불요. broadcast 실패는 격리 (task 진행은 유지).
   */
  async addIntervention(
    params: AddInterventionParams,
    onResume: StartExecutionCallback,
  ): Promise<AddInterventionResult> {
    return await this.interventionRoute.addIntervention(params, onResume);
  }

  private async resolveNotificationTask(sessionId: string): Promise<Task | null> {
    const active = this.tasks.get(sessionId);
    if (active) return active;
    const loaded = await this.loadEvictedTask(sessionId);
    if (!loaded) return null;
    this.tasks.set(sessionId, loaded);
    return loaded;
  }

}
