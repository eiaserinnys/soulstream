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
import { DEFAULT_FOLDERS, type SessionDB } from "../db/session_db.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { ContextItem } from "../context/prompt_assembler.js";

import type {
  CallerInfo,
  InterventionMessage,
  SessionType,
  Task,
  TaskStatus,
} from "./task_models.js";
import { AutoResumeTransition } from "./task_auto_resume_transition.js";
import {
  buildCallerInfoMetadataEntry,
  extractAgentsRunStateFromMetadata,
  extractAgentsSessionItemsFromMetadata,
  extractCallerInfoFromMetadata,
} from "./task_metadata.js";
import {
  RunningInterventionTransition,
  type RunningInterventionResult,
} from "./task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type {
  BackendId,
  InputResponseDeliveryResult,
  ReasoningEffort,
  SSEEventPayload,
  SupportsInputResponse,
  SupportsToolApproval,
  ToolApprovalDecision,
  ToolApprovalDeliveryResult,
} from "../engine/protocol.js";

export interface CreateTaskParams {
  agentSessionId: string;
  prompt: string;
  profileId?: string;
  clientId?: string | null;
  sessionType?: SessionType;
  llmProvider?: string | null;
  llmModel?: string | null;
  llmUsage?: Record<string, number> | null;
  callerSessionId?: string | null;
  callerInfo?: CallerInfo;
  model?: string | null;
  oauthToken?: string;
  reasoningEffort?: ReasoningEffort;
  /** 요청별 허용 도구 override. 없으면 AgentProfile.allowed_tools 사용. */
  allowedTools?: string[];
  /** 요청별 금지 도구 override. 없으면 AgentProfile.disallowed_tools 사용. */
  disallowedTools?: string[];
  /** 요청별 MCP 사용 여부. undefined면 true. */
  useMcp?: boolean;
  folderId?: string | null;
  /** B-6 context_builder: 사용자/위임자 system_prompt. folder_prompt와 합성됨. */
  systemPrompt?: string;
  /** 첫 turn prompt와 user_message.context에 함께 박을 외부 context items. */
  contextItems?: ContextItem[];
  /** 첫 turn user_message.attachments와 engine image 입력 분리에 사용할 원본 첨부 경로. */
  attachmentPaths?: string[];
}

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
  private readonly runningInterventionTransition: RunningInterventionTransition;
  private readonly autoResumeTransition: AutoResumeTransition;

  constructor(
    private readonly nodeId: string,
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
    private readonly logger: Logger,
    /**
     * B-5: intervention_sent 영속화에 사용 (Python `task_executor.py:352-389
     * on_intervention_sent` 정본 정합). undefined일 때 영속화는 skip (legacy
     * 호출자·테스트 환경 호환 — broadcast만 발행).
     */
    private readonly persistence?: EventPersistence,
    /**
     * Phase A context 정본 진입점 (atom d7a1ad86 차단):
     * auto-resume transition이 user_message wire에 박을 ContextItem[]을 조립할 때 사용.
     * undefined일 때 context 박지 않음 (legacy 호출자·단위 테스트 호환 — design-principles §8 실패 격리).
     */
    private readonly contextBuilder?: ExecutionContextBuilder,
    private readonly agentRegistry?: AgentRegistry,
  ) {
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
  }

  /**
   * 새 Task 생성 + DB 등록 + orch broadcast.
   *
   * 같은 agentSessionId가 이미 있으면 throw — 중복 차단.
   * DB register 실패 시 in-memory map에 task를 *남기지 않음* (실패 격리).
   */
  async createTask(params: CreateTaskParams): Promise<Task> {
    if (this.tasks.has(params.agentSessionId)) {
      throw new Error(`Task already exists: ${params.agentSessionId}`);
    }

    const now = new Date();
    const metadata = buildCallerInfoMetadataEntry(params.callerInfo);
    const sessionType = params.sessionType ?? "claude";
    const task: Task = {
      agentSessionId: params.agentSessionId,
      prompt: params.prompt,
      status: "running",
      profileId: params.profileId,
      clientId: params.clientId ?? null,
      sessionType,
      llmProvider: params.llmProvider ?? null,
      llmModel: params.llmModel ?? null,
      llmUsage: params.llmUsage ?? null,
      callerSessionId: params.callerSessionId ?? undefined,
      callerInfo: params.callerInfo,
      metadata: metadata ? [metadata] : [],
      model: params.model,
      oauthToken: params.oauthToken,
      reasoningEffort: params.reasoningEffort,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      useMcp: params.useMcp,
      systemPrompt: params.systemPrompt,  // B-6 context_builder
      contextItems: params.contextItems,
      attachmentPaths: params.attachmentPaths,
      createdAt: now,
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    };

    // DB 등록 — schema.sql session_register는 *INSERT only*, ON CONFLICT 없음.
    // 같은 session_id 중복 INSERT 시 PK violation throw → 호출자에게 신호.
    await this.db.registerSession({
      sessionId: task.agentSessionId,
      nodeId: this.nodeId,
      agentId: task.profileId ?? null,
      claudeSessionId: null,  // 처음에는 null — Codex thread_id 받으면 별도 update (B-3 범위 외, 후속)
      sessionType,
      prompt: task.prompt,
      clientId: task.clientId ?? null,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.createdAt,
      callerSessionId: task.callerSessionId ?? null,
    });

    // caller_info를 Task.metadata와 DB에 동시 저장. Python TaskFactory와 같은 타이밍:
    // session_created 전에 박아 feed/folder 초기 카드가 metadata fallback을 즉시 사용할 수 있게 한다.
    if (metadata) {
      await this.db.appendMetadata(task.agentSessionId, metadata);
    }

    this.tasks.set(task.agentSessionId, task);

    // 폴더 배정 + catalog_updated broadcast (Python `task_manager.py:284-323`
    // `_assign_default_folder_and_broadcast` 정본). codex 세션이 dashboard 폴더 트리에서
    // 보이지 않던 결함의 정본 fix — session_register는 folder_id를 받지 않으므로 *별도*
    // session_assign_folder로 박는다. folder_id 미지정 시 session_type 기반 기본 폴더 폴백.
    //
    // 부가 기능 — 실패는 격리 (Python L292-293 코멘트 정합).
    const assignedFolderId = await this._assignFolderAndBroadcastCatalog(
      task.agentSessionId,
      sessionType,
      params.folderId ?? null,
    );

    // broadcast session_created — 실패해도 task는 메모리에 살아있음 (orch 재연결 시 동기 가능).
    // Python L304-313 정합: catalog_updated 이후 session_created 발행 (순서 보장).
    try {
      await this.broadcaster.emitSessionCreated(task, assignedFolderId);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_created broadcast failed",
      );
    }

    return task;
  }

  /**
   * 신규 세션을 폴더에 배정 + catalog_updated wire broadcast.
   *
   * Python `service/task_manager.py:284-323 _assign_default_folder_and_broadcast` 정본 이식.
   *   - folder_id 명시 → 그 폴더에 배정
   *   - 미지정 → `DEFAULT_FOLDERS[sessionType]` 기본 폴더 lookup → 배정
   *   - 기본 폴더 미존재 → 폴더 배정 없음(graceful) + broadcast 없음
   *   - 폴더 배정 후 `getCatalog` + `emitCatalogUpdated` (dashboard 폴더 트리 즉시 갱신)
   *
   * 부가 기능 — 각 단계 실패를 격리 (Python L292-293 "폴더 배정이나 브로드캐스트에 실패해도
   * 호출자의 핵심 동작(세션 생성/등록)에 영향을 주지 않는다").
   *
   * 반환: 최종 배정된 folder_id. 배정 안 됐으면 null.
   */
  private async _assignFolderAndBroadcastCatalog(
    sessionId: string,
    sessionType: string,
    folderId: string | null,
  ): Promise<string | null> {
    let assigned: string | null = null;
    try {
      if (folderId !== null) {
        await this.db.assignSessionToFolder(sessionId, folderId);
        assigned = folderId;
      } else {
        // Python L302-303 `DEFAULT_FOLDERS.get(session_type, DEFAULT_FOLDERS["claude"])` 정합.
        // `DEFAULT_FOLDERS.claude`는 정본 상수(session_db.ts:35)에 *항상* 정의되어 있으므로
        // non-null assertion으로 명시. 추가 폴백(`?? ""`)은 *불가능 분기*라 design-principles §3
        // 정본 하나 측면에서 제거 (code-reviewer P2-3).
        const claudeDefault = DEFAULT_FOLDERS["claude"] as string;
        const defaultName = DEFAULT_FOLDERS[sessionType] ?? claudeDefault;
        const folder = await this.db.getDefaultFolder(defaultName);
        if (folder) {
          await this.db.assignSessionToFolder(sessionId, folder.id);
          assigned = folder.id;
        }
      }
    } catch (err) {
      this.logger.warn(
        { err, sessionId },
        "assignSessionToFolder failed — proceeding without folder",
      );
    }

    if (assigned !== null) {
      try {
        const catalog = await this.db.getCatalog();
        await this.broadcaster.emitCatalogUpdated(catalog);
      } catch (err) {
        this.logger.warn(
          { err, sessionId },
          "catalog_updated broadcast failed",
        );
      }
    }

    return assigned;
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

    const eventId = await this.persistAndBroadcastInputRequestResponded(
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
    let task = this.tasks.get(params.agentSessionId);
    if (!task) {
      task = await this.loadEvictedTask(params.agentSessionId) ?? undefined;
      if (!task) {
        return {
          status: "session_not_found",
          approvalId: params.approvalId,
          decision: params.decision,
        };
      }
      this.tasks.set(task.agentSessionId, task);
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
      const queued = await this.queueAgentsToolApprovalResume(task, params, onResume);
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
      {
        ...(params.message ? { message: params.message } : {}),
        ...(params.alwaysApprove !== undefined
          ? { alwaysApprove: params.alwaysApprove }
          : {}),
        ...(params.alwaysReject !== undefined
          ? { alwaysReject: params.alwaysReject }
          : {}),
      },
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

    const eventId = await this.persistAndBroadcastToolApprovalResolved(task, params);
    return {
      status: "delivered",
      approvalId: params.approvalId,
      decision: params.decision,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }

  private async queueAgentsToolApprovalResume(
    task: Task,
    params: DeliverToolApprovalParams,
    onResume: StartExecutionCallback | undefined,
  ): Promise<DeliverToolApprovalResult | undefined> {
    if (!onResume) return undefined;
    if (!task.agentsRunState || task.agentsPendingApprovalId !== params.approvalId) {
      return undefined;
    }
    task.agentsQueuedToolApproval = {
      approvalId: params.approvalId,
      decision: params.decision,
      options: {
        ...(params.message ? { message: params.message } : {}),
        ...(params.alwaysApprove !== undefined ? { alwaysApprove: params.alwaysApprove } : {}),
        ...(params.alwaysReject !== undefined ? { alwaysReject: params.alwaysReject } : {}),
      },
    };
    const eventId = await this.persistAndBroadcastToolApprovalResolved(task, params);
    try {
      await this.broadcaster.emitSessionUpdated(task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_updated (tool approval resume) broadcast failed",
      );
    }
    onResume(task);
    return {
      status: "delivered",
      approvalId: params.approvalId,
      decision: params.decision,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }

  private async persistAndBroadcastInputRequestResponded(
    task: Task,
    requestId: string,
  ): Promise<number | undefined> {
    const event: Record<string, unknown> = {
      type: "input_request_responded",
      request_id: requestId,
      timestamp: Date.now() / 1000,
    };
    let eventId: number | undefined;

    if (this.persistence) {
      try {
        eventId = await this.persistence.persistEvent(
          task.agentSessionId,
          event as SSEEventPayload,
        );
        task.lastEventId = eventId;
        event._event_id = eventId;
        await this.persistence.handleSideEffects(
          task.agentSessionId,
          event as SSEEventPayload,
          task,
        );
      } catch (err) {
        this.logger.warn(
          { err, sessionId: task.agentSessionId, requestId },
          "input_request_responded persistence failed",
        );
        eventId = undefined;
      }
    }

    try {
      await this.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        event as SSEEventPayload,
      );
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, requestId },
        "input_request_responded broadcast failed",
      );
    }
    return eventId;
  }

  private async persistAndBroadcastToolApprovalResolved(
    task: Task,
    params: DeliverToolApprovalParams,
  ): Promise<number | undefined> {
    const event: Record<string, unknown> = {
      type: "tool_approval_resolved",
      approval_id: params.approvalId,
      decision: params.decision,
      approved: params.decision === "approved",
      rejected: params.decision === "rejected",
      timestamp: Date.now() / 1000,
    };
    if (params.message) {
      event.message = params.message;
    }

    let eventId: number | undefined;
    if (this.persistence) {
      try {
        eventId = await this.persistence.persistEvent(
          task.agentSessionId,
          event as SSEEventPayload,
        );
        task.lastEventId = eventId;
        event._event_id = eventId;
        await this.persistence.handleSideEffects(
          task.agentSessionId,
          event as SSEEventPayload,
          task,
        );
      } catch (err) {
        this.logger.warn(
          { err, sessionId: task.agentSessionId, approvalId: params.approvalId },
          "tool_approval_resolved persistence failed",
        );
        eventId = undefined;
      }
    }

    try {
      await this.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        event as SSEEventPayload,
      );
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId, approvalId: params.approvalId },
        "tool_approval_resolved broadcast failed",
      );
    }
    return eventId;
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
    const task = this.tasks.get(sessionId);
    if (!task) return false;
    if (task.status !== "running") return false;
    if (!task.engine) return false;
    task.status = "interrupted";
    return await task.engine.interrupt();
  }

  /**
   * Task 제거. 메모리 + DB + broadcast.
   * 진행 중이면 cancel 후 promise drain 대기.
   */
  async deleteTask(sessionId: string): Promise<void> {
    const task = this.tasks.get(sessionId);
    if (!task) return;

    // engine 살아있으면 status 무관하게 interrupt + drain
    // (cancelTask 후 deleteTask 호출 시 status="interrupted"라도 engine drain 대기 의무)
    if (task.engine) {
      try {
        await task.engine.interrupt();
      } catch {
        // interrupt가 이미 idempotent — 무시
      }
      if (task.executionPromise) {
        try {
          await task.executionPromise;
        } catch {
          // ignore — interrupted promise rejection
        }
      }
    }

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
        task.status = "interrupted";
        task.completedAt = shutdownAt;
        try {
          await this.db.updateSession(task.agentSessionId, {
            status: "interrupted",
            last_event_id: task.lastEventId,
          });
        } catch (err) {
          this.logger.warn(
            { err, sessionId: task.agentSessionId },
            "DB updateSession failed during shutdown interrupt",
          );
        }
        try {
          await this.broadcaster.emitSessionUpdated(task);
        } catch (err) {
          this.logger.warn(
            { err, sessionId: task.agentSessionId },
            "session_updated broadcast failed during shutdown interrupt",
          );
        }
      }
      // engine 살아있으면 status 무관하게 interrupt + drain — interrupted 직후 shutdown
      // 같은 race도 안전하게 처리.
      if (task.engine) {
        try {
          await task.engine.interrupt();
        } catch {
          // idempotent — 무시
        }
        if (task.executionPromise) {
          drains.push(task.executionPromise.catch(() => undefined));
        }
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

    try {
      await this.db.updateSession(task.agentSessionId, {
        status: task.status,
        last_event_id: task.lastEventId,
      });
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "DB updateSession failed in finalizeTask",
      );
    }

    try {
      await this.broadcaster.emitSessionUpdated(task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_updated broadcast failed in finalizeTask",
      );
    }

    return task;
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
    if (isDetachedHydratedRunningTask(task)) {
      this.logger.warn(
        { sessionId: task.agentSessionId },
        "hydrated running task has no active execution; auto-resuming instead of queueing",
      );
      task.status = "interrupted";
      task.completedAt = new Date();
    }

    if (task.status === "running") {
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

    // status 검증 — DB에 비정상 값이 있으면 null 반환 (Python L129-134 정합).
    const status = row.status;
    const validStatuses: readonly TaskStatus[] = ["running", "completed", "error", "interrupted"];
    if (!status || !validStatuses.includes(status as TaskStatus)) {
      this.logger.warn(
        { sessionId, status, createdAt: row.created_at },
        "loadEvictedTask: incomplete or invalid SessionRow",
      );
      return null;
    }

    // completed_at: status가 terminal이면 updated_at 사용 (Python L137-146 정합).
    let completedAt: Date | undefined;
    if (status === "completed" || status === "error" || status === "interrupted") {
      completedAt = row.updated_at ?? undefined;
    }

    const metadata = Array.isArray(row.metadata)
      ? (row.metadata as Array<Record<string, unknown>>)
      : [];
    const agentsRunState = extractAgentsRunStateFromMetadata(metadata);
    const agentsSessionItems = extractAgentsSessionItemsFromMetadata(metadata);

    const task: Task = {
      agentSessionId: row.session_id,
      prompt: row.prompt ?? "",
      status: status as TaskStatus,
      hydratedFromDb: true,
      profileId: row.agent_id ?? undefined,
      clientId: row.client_id,
      sessionType: row.session_type === "llm" ? "llm" : "claude",
      codexThreadId: row.claude_session_id ?? undefined,
      callerSessionId: row.caller_session_id ?? undefined,
      // P0 (code-reviewer): metadata JSONB array에서 *마지막 신원 박힌* caller_info entry 복원.
      // 누락 시 R-2 회로(dashboard owner Google portrait fallback) codex 경로에 재현 —
      // Python `session_eviction_manager.py:148-156` 주석이 명시. Python
      // `extract_caller_info_from_metadata` (`packages/soul-common/.../auth/caller_info.py:119-163`)
      // 정본 인라인 이식.
      callerInfo: extractCallerInfoFromMetadata(row.metadata),
      metadata,
      agentsRunState: agentsRunState?.serialized,
      agentsRunStateSchemaVersion: agentsRunState?.schemaVersion,
      agentsPendingApprovalId: agentsRunState?.pendingApprovalId,
      agentsPreviousResponseId: agentsRunState?.previousResponseId,
      agentsConversationId: agentsRunState?.conversationId,
      agentsSessionItems,
      createdAt: row.created_at,
      completedAt,
      lastEventId: row.last_event_id ?? 0,
      lastReadEventId: row.last_read_event_id ?? 0,
      interventionQueue: [],
    };
    return task;
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

function isDetachedHydratedRunningTask(task: Task): boolean {
  return (
    task.status === "running" &&
    task.hydratedFromDb === true &&
    !task.engine &&
    !task.executionPromise
  );
}

function taskBackend(task: Task, agentRegistry?: AgentRegistry): BackendId | string | undefined {
  if (task.engine?.backendId) return task.engine.backendId;
  if (task.profileId && agentRegistry) {
    return agentRegistry.get(task.profileId)?.backend;
  }
  return undefined;
}
