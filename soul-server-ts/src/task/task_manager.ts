/**
 * TaskManager — 세션 task 컬렉션 관리 (Phase B-3 기본 + B-4 intervention).
 *
 * Python `service/task_manager.py`의 *codex 적응판*. session_eviction은 본 PR 범위 외
 * (codex MVP).
 *
 * 책임:
 *   - createTask: Task 생성 + DB `session_register` + broadcast `session_created`
 *   - getTask / listTasks
 *   - cancelTask: 진행 중 turn abort
 *   - deleteTask: 메모리 + DB + broadcast `session_deleted`
 *   - addIntervention (B-4): turn 사이 큐잉 또는 auto-resume — 분석 캐시
 *     `20260517-1410-codex-ts-folder-resume-intervene.md` §D
 *
 * 본 PR은 *task lifecycle 메타 관리*만. 실제 *engine 실행*은 TaskExecutor 책임.
 */

import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { SessionDB } from "../db/session_db.js";
import type { EventPersistence } from "../db/event_persistence.js";

import type {
  CallerInfo,
  InterventionMessage,
  Task,
  TaskStatus,
} from "./task_models.js";
import { ActiveTaskRecovery } from "./task_active_recovery.js";
import { AutoResumeTransition } from "./task_auto_resume_transition.js";
import { hydrateEvictedTaskFromSessionRow } from "./task_evicted_hydration.js";
import { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import {
  buildToolApprovalOptions,
  ToolApprovalRecovery,
} from "./task_tool_approval_recovery.js";
import {
  RunningInterventionTransition,
  type RunningInterventionResult,
} from "./task_running_intervention_transition.js";
import {
  TaskCreation,
  type CreateTaskParams,
} from "./task_creation.js";
import { ResponseEventPublisher } from "./task_response_event_publisher.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type {
  BackendId,
  InputResponseDeliveryResult,
  SupportsInputResponse,
  SupportsToolApproval,
  ToolApprovalDecision,
  ToolApprovalDeliveryResult,
} from "../engine/protocol.js";

export type { CreateTaskParams } from "./task_creation.js";

/**
 * `addIntervention` 결과. Python `task_manager.add_intervention` L590-595 정본 형상.
 *
 * - running 세션 + live steering 지원 → `{delivered: true}` — 현 active turn에 직접 전달.
 * - running 세션 fallback → `{queued: true, queuePosition}` — 현 turn 종료 후 task_executor가 dequeue.
 * - completed/error/interrupted → `{autoResumed: true}` — task_executor.startExecution이
 *   resumeSessionId(task.codexThreadId)로 다음 turn 자동 시작.
 */
export type AddInterventionResult =
  | RunningInterventionResult
  | { autoResumed: true };

/** addIntervention이 받는 메시지. dispatcher가 wire payload에서 조립. */
export interface AddInterventionParams {
  agentSessionId: string;
  text: string;
  user: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
}

export type DeliverInputResponseStatus =
  | InputResponseDeliveryResult["status"]
  | "session_not_found"
  | "session_not_running";

export interface DeliverInputResponseParams {
  agentSessionId: string;
  requestId: string;
  answers: Record<string, unknown>;
}

export interface DeliverInputResponseResult {
  status: DeliverInputResponseStatus;
  requestId: string;
  eventId?: number;
  message?: string;
  taskStatus?: TaskStatus;
  backend?: BackendId | string;
}

export type DeliverToolApprovalStatus =
  | ToolApprovalDeliveryResult["status"]
  | "session_not_found"
  | "session_not_running";

export interface DeliverToolApprovalParams {
  agentSessionId: string;
  approvalId: string;
  decision: ToolApprovalDecision;
  message?: string;
  alwaysApprove?: boolean;
  alwaysReject?: boolean;
}

export interface DeliverToolApprovalResult {
  status: DeliverToolApprovalStatus;
  approvalId: string;
  decision: ToolApprovalDecision;
  eventId?: number;
  message?: string;
  taskStatus?: TaskStatus;
  backend?: BackendId | string;
}

export interface FinalizeTaskParams {
  agentSessionId: string;
  result?: string;
  error?: string;
  llmUsage?: Record<string, number> | null;
}

/**
 * `addIntervention`의 auto-resume 경로 콜백.
 *
 * Task가 completed/error/interrupted일 때 task_manager는 status를 "running"으로
 * 돌리고 queue에 메시지를 push한 뒤 본 콜백을 호출한다. 콜백은 *task_executor.startExecution*을
 * 호출하여 다음 turn을 시작할 책임. design-principles §1(지식 경계) — task_manager는
 * executor를 알지 않는다.
 */
export type StartExecutionCallback = (task: Task) => void;

export class TaskManager {
  private readonly tasks = new Map<string, Task>();
  private readonly taskCreation: TaskCreation;
  private readonly activeTaskRecovery: ActiveTaskRecovery;
  private readonly runningInterventionTransition: RunningInterventionTransition;
  private readonly autoResumeTransition: AutoResumeTransition;
  private readonly toolApprovalRecovery: ToolApprovalRecovery;
  private readonly responseEventPublisher: ResponseEventPublisher;
  private readonly lifecycleTransition: TaskLifecycleTransition;

  constructor(
    nodeId: string,
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
    private readonly logger: Logger,
    /**
     * B-5: intervention_sent 영속화에 사용 (Python `task_executor.py:352-389
     * on_intervention_sent` 정본 정합). undefined일 때 영속화는 skip (legacy
     * 호출자·테스트 환경 호환 — broadcast만 발행).
     */
    persistence?: EventPersistence,
    /**
     * Phase A context 정본 진입점 (atom d7a1ad86 차단):
     * auto-resume transition이 user_message wire에 박을 ContextItem[]을 조립할 때 사용.
     * undefined일 때 context 박지 않음 (legacy 호출자·단위 테스트 호환 — design-principles §8 실패 격리).
     */
    contextBuilder?: ExecutionContextBuilder,
    private readonly agentRegistry?: AgentRegistry,
  ) {
    this.taskCreation = new TaskCreation({
      nodeId,
      db,
      broadcaster,
      logger,
      hasTask: (sessionId) => this.tasks.has(sessionId),
      rememberTask: (task) => {
        this.tasks.set(task.agentSessionId, task);
      },
    });
    this.lifecycleTransition = new TaskLifecycleTransition({
      db,
      broadcaster,
      logger,
    });
    this.activeTaskRecovery = new ActiveTaskRecovery(logger);
    this.runningInterventionTransition = new RunningInterventionTransition({
      broadcaster,
      logger,
      persistence,
    });
    this.autoResumeTransition = new AutoResumeTransition({
      db,
      broadcaster,
      logger,
      persistence,
      contextBuilder,
      agentRegistry,
    });
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
  }

  /**
   * 새 Task 생성 + DB 등록 + orch broadcast. 신규 task creation policy는
   * TaskCreation이 소유하고, TaskManager는 public collection API를 유지한다.
   */
  async createTask(params: CreateTaskParams): Promise<Task> {
    return await this.taskCreation.createTask(params);
  }

  getTask(sessionId: string): Task | undefined {
    return this.tasks.get(sessionId);
  }

  listTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * AskUserQuestion/input_request 응답 전달.
   *
   * TaskManager는 세션 lifecycle과 persisted event만 책임진다. 실제 응답 주입은
   * EnginePort 선택 capability(SupportsInputResponse)에 위임하여 Codex 경로 누수를 막는다.
   */
  async deliverInputResponse(
    params: DeliverInputResponseParams,
  ): Promise<DeliverInputResponseResult> {
    const task = this.tasks.get(params.agentSessionId);
    if (!task) {
      return { status: "session_not_found", requestId: params.requestId };
    }
    if (task.status !== "running") {
      return {
        status: "session_not_running",
        requestId: params.requestId,
        taskStatus: task.status,
      };
    }

    const engine = task.engine;
    if (!supportsInputResponse(engine)) {
      return {
        status: "not_supported",
        requestId: params.requestId,
        backend: taskBackend(task, this.agentRegistry),
      };
    }

    const delivered = await engine.deliverInputResponse(params.requestId, params.answers);
    if (delivered.status !== "delivered") {
      return {
        status: delivered.status,
        requestId: params.requestId,
        ...(delivered.message ? { message: delivered.message } : {}),
        ...(delivered.status === "not_supported"
          ? { backend: taskBackend(task, this.agentRegistry) }
          : {}),
      };
    }

    const eventId = await this.responseEventPublisher.publishInputRequestResponded(
      task,
      params.requestId,
    );
    return {
      status: "delivered",
      requestId: params.requestId,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }

  /**
   * Agents SDK tool approval 전달.
   *
   * AskUserQuestion/respond와 별도 capability로 분리한다. `respond`는 Claude
   * input_request에만 대응하고, `approve_tool`/`reject_tool`은 Agents SDK
   * RunToolApprovalItem interruption에만 대응한다.
   */
  async deliverToolApproval(
    params: DeliverToolApprovalParams,
    onResume?: StartExecutionCallback,
  ): Promise<DeliverToolApprovalResult> {
    const task = await this.toolApprovalRecovery.resolveTaskForApproval(
      params.agentSessionId,
    );
    if (!task) {
      return {
        status: "session_not_found",
        approvalId: params.approvalId,
        decision: params.decision,
      };
    }
    if (task.status !== "running") {
      return {
        status: "session_not_running",
        approvalId: params.approvalId,
        decision: params.decision,
        taskStatus: task.status,
      };
    }

    const engine = task.engine;
    if (!supportsToolApproval(engine)) {
      const queued = await this.toolApprovalRecovery.tryQueueAgentsResume(
        task,
        params,
        onResume,
      );
      if (queued) return queued;
      return {
        status: "not_supported",
        approvalId: params.approvalId,
        decision: params.decision,
        backend: taskBackend(task, this.agentRegistry),
      };
    }

    const delivered = await engine.deliverToolApproval(
      params.approvalId,
      params.decision,
      buildToolApprovalOptions(params),
    );
    if (delivered.status !== "delivered") {
      return {
        status: delivered.status,
        approvalId: params.approvalId,
        decision: params.decision,
        ...(delivered.message ? { message: delivered.message } : {}),
        ...(delivered.status === "not_supported"
          ? { backend: taskBackend(task, this.agentRegistry) }
          : {}),
      };
    }

    const eventId = await this.responseEventPublisher.publishToolApprovalResolved(
      task,
      params,
    );
    return {
      status: "delivered",
      approvalId: params.approvalId,
      decision: params.decision,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }

  /**
   * 진행 중 turn abort. 성공 시 status=interrupted로 전환. 없으면 false.
   *
   * code-reviewer P1 정정: status="interrupted" 박힘은 *여기서* 책임진다.
   * adapter abort catch는 yield 없이 generator를 정상 종료 — task_executor의
   * 정상 종료 분기 `if (task.status === "running") task.status = "completed"`가
   * interrupt 경로에도 발동되어 wire가 "completed"로 박히는 결함을 차단.
   *
   * 본 메서드가 status를 *engine.interrupt 호출 전*에 박으므로, 그 후 generator가
   * 정상 종료해도 _consumeEventStream의 가드가 status를 덮지 않는다.
   * finalize의 DB session_update + emit_session_updated는 interrupted 그대로 발행.
   */
  async cancelTask(sessionId: string): Promise<boolean> {
    return await this.lifecycleTransition.cancelRunningTask(
      this.tasks.get(sessionId),
    );
  }

  /**
   * Task 제거. 메모리 + DB + broadcast.
   * 진행 중이면 cancel 후 promise drain 대기.
   */
  async deleteTask(sessionId: string): Promise<void> {
    const task = this.tasks.get(sessionId);
    if (!task) return;

    await this.lifecycleTransition.interruptAndDrain(task);

    this.tasks.delete(sessionId);

    try {
      await this.db.deleteSession(sessionId);
    } catch (err) {
      this.logger.warn({ err, sessionId }, "DB deleteSession failed");
    }

    try {
      await this.broadcaster.emitSessionDeleted(sessionId);
    } catch (err) {
      this.logger.warn({ err, sessionId }, "session_deleted broadcast failed");
    }
  }

  /**
   * 모든 진행 중 task 정지 + drain. shutdown 시 호출.
   * 종료 신호 직후 DB 상태를 terminal로 먼저 기록한다. 프로세스 재시작이 drain보다
   * 먼저 완료되어도 대시보드에 stale running 세션이 남지 않아야 한다.
   */
  async shutdown(): Promise<void> {
    const drains: Promise<void>[] = [];
    const shutdownAt = new Date();
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        await this.lifecycleTransition.markRunningTaskInterruptedForShutdown(
          task,
          shutdownAt,
        );
      }
      const hadEngine = Boolean(task.engine);
      await this.lifecycleTransition.interruptForShutdown(task);
      const drain = hadEngine
        ? this.lifecycleTransition.getDrainPromise(task)
        : undefined;
      if (drain) {
        drains.push(drain);
      }
    }
    await Promise.all(drains);
  }

  /** 내부 상태 변경 helper (task_executor용). */
  setTaskStatus(sessionId: string, status: TaskStatus): void {
    const task = this.tasks.get(sessionId);
    if (task) task.status = status;
  }

  /**
   * 외부 실행기(LLM proxy 등)가 만든 task를 완료/실패 상태로 마무리한다.
   *
   * TaskExecutor._finalize는 engine lifecycle까지 닫는 전용 경로라 LLM proxy에서 재사용할 수 없다.
   * 이 메서드는 세션 상태·완료 시각·LLM usage만 갱신하고 session_updated wire를 발행한다.
   */
  async finalizeTask(params: FinalizeTaskParams): Promise<Task | undefined> {
    if (params.result === undefined && params.error === undefined) {
      throw new Error("finalizeTask requires either result or error");
    }

    const task = this.tasks.get(params.agentSessionId);
    if (!task) {
      this.logger.warn(
        { sessionId: params.agentSessionId },
        "Task not found for finalizeTask",
      );
      return undefined;
    }

    return await this.lifecycleTransition.finalizeExternalTask(task, params);
  }

  /**
   * Turn 사이 개입 메시지 추가 (B-4, 분석 캐시
   * `20260517-1410-codex-ts-folder-resume-intervene.md` §D-3).
   *
 * Python `service/task_manager.py:563-642 add_intervention` 정본의 codex 적응판.
 *
 * 분기:
 *   - Running + live steering capability: active turn에 직접 전달 → `{delivered}`.
 *   - Running fallback: interventionQueue에 push → intervention_sent broadcast → `{queued, queuePosition}`.
 *     현 turn 종료 후 task_executor가 dequeue하여 다음 turn으로 자동 진입.
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
    // B-5 결함 D 정정 (PR #56): 메모리에 task가 없으면 DB에서 lazy hydration.
    // 서버 재기동 후 기존 세션에 메시지 도착 시 무조건 throw하던 결함 봉인. Python
    // `task_manager.py:615-619`의 evicted task on-demand 로드 정합 — 분석 캐시
    // `20260517-2300-codex-ts-hydration-and-typing-redo.md` §A.
    let task: Task | undefined = this.tasks.get(params.agentSessionId);
    if (!task) {
      const loaded = await this.loadEvictedTask(params.agentSessionId);
      if (!loaded) {
        throw new Error(`Task not found: ${params.agentSessionId}`);
      }
      task = loaded;
      this.tasks.set(task.agentSessionId, task);
    }

    const message: InterventionMessage = {
      text: params.text,
      user: params.user,
      callerInfo: params.callerInfo,
      attachmentPaths: params.attachmentPaths,
    };

    // B-5 결함 A 정정: wire 분기를 task.status에 따라 분리.
    //
    //  - 진행 중 (task.status === "running") → intervention_sent (UI 주황색)
    //    Python `task_executor.py:352-389 on_intervention_sent` 정본
    //  - 완료 후 (completed/error/interrupted) → user_message (UI 흰색) + auto-resume
    //    Python `task_manager.py:635 create_task(prompt=text, ...)` 정본 — 새 task에서
    //    _persist_initial_messages가 user_message를 박는 모델과 의미 등가.
    //
    // PR #54까지는 두 경로 모두 intervention_sent로 박혀 사용자 보고 "2턴 이후 전부 주황색"
    // 결함. 본 정정으로 wire 분류 정합.
    if (this.activeTaskRecovery.prepareForIntervention(task) === "running") {
      return await this._addInterventionRunning(task, message);
    }
    return await this._addInterventionAutoResume(task, message, onResume);
  }

  /**
   * 진행 중 task에 intervention 도착 → intervention_sent 영속화 + broadcast.
   *
   * live steering capability가 있으면 현 active turn에 직접 주입한다. 미지원/실패 시 기존처럼
   * queue.push 후 task_executor가 현 turn 종료 뒤 dequeue하여 다음 turn으로 진입한다.
   */
  private async _addInterventionRunning(
    task: Task,
    message: InterventionMessage,
  ): Promise<AddInterventionResult> {
    return await this.runningInterventionTransition.deliver(task, message);
  }

  /**
   * Completed/Error/Interrupted task에 intervention 도착 → user_message 영속화·broadcast +
   * status="running" 전환 + session_updated wire + onResume.
   *
   * Python `task_manager.py:635 create_task(prompt=text)` 모델의 codex 적응판. 같은 task
   * 인스턴스를 재활용하지만 *새 turn 진입 시* user_message가 자기 wire로 영속화·broadcast되어
   * 클라이언트 채팅 UI에 흰색으로 표시. 또한 `emitSessionUpdated(task)`로 task.status="running"을
   * wire에 즉시 반영 — soul-app TypingIndicator(`session.status === "running"`)가 즉시 표시.
   *
   * race 보호: P1-1 (code-reviewer PR #52). task.executionPromise drain으로 _finalize 완료
   * 보장 후 진입.
   */
  private async _addInterventionAutoResume(
    task: Task,
    message: InterventionMessage,
    onResume: StartExecutionCallback,
  ): Promise<AddInterventionResult> {
    return await this.autoResumeTransition.resume(task, message, onResume);
  }

  /**
   * DB에서 퇴거된(또는 서버 재기동으로 메모리 손실된) task를 lazy hydration.
   *
   * Python `service/session_eviction_manager.py:106-178 load_evicted_task` 정본의 codex 적응판.
   * sessions 테이블의 SessionRow를 Task 인스턴스로 재구성. codex thread id는 PR #48 F-3B로
   * `sessions.claude_session_id` 컬럼에 영속화되어 있어, hydrate 시 task.codexThreadId로
   * 복원되고 codex SDK `resumeThread(threadId)`가 thread 자체를 복원한다.
   *
   * DB에 세션이 없으면 null 반환 — 호출자(addIntervention)가 throw하여 graceful.
   *
   * 본 메서드는 *메모리에 task를 추가하지 않는다* — 호출자가 결정. addIntervention의
   * auto-resume 분기가 task를 직접 mutate하므로 메모리 추가가 필요.
   *
   * 미복원 필드 (별건 카드 권고):
   *   - lastAssistantText·lastProgressText: events 테이블에서 재계산 필요 — 본 PR 범위 외.
   */
  private async loadEvictedTask(sessionId: string): Promise<Task | null> {
    let row;
    try {
      row = await this.db.getSession(sessionId);
    } catch (err) {
      this.logger.warn({ err, sessionId }, "loadEvictedTask: getSession failed");
      return null;
    }
    if (!row) return null;

    return hydrateEvictedTaskFromSessionRow(row, this.logger);
  }
}

function supportsInputResponse(
  engine: Task["engine"],
): engine is NonNullable<Task["engine"]> & SupportsInputResponse {
  return Boolean(
    engine &&
      typeof (engine as unknown as Partial<SupportsInputResponse>).deliverInputResponse ===
        "function",
  );
}

function supportsToolApproval(
  engine: Task["engine"],
): engine is NonNullable<Task["engine"]> & SupportsToolApproval {
  return Boolean(
    engine &&
      typeof (engine as unknown as Partial<SupportsToolApproval>).deliverToolApproval ===
        "function",
  );
}

function taskBackend(task: Task, agentRegistry?: AgentRegistry): BackendId | string | undefined {
  if (task.engine?.backendId) return task.engine.backendId;
  if (task.profileId && agentRegistry) {
    return agentRegistry.get(task.profileId)?.backend;
  }
  return undefined;
}
