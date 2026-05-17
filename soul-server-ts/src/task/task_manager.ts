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

import { DEFAULT_FOLDERS, type SessionDB } from "../db/session_db.js";
import type { EventPersistence } from "../db/event_persistence.js";

import type { CallerInfo, InterventionMessage, Task, TaskStatus } from "./task_models.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { SSEEventPayload } from "../engine/protocol.js";

export interface CreateTaskParams {
  agentSessionId: string;
  prompt: string;
  profileId?: string;
  callerSessionId?: string | null;
  callerInfo?: CallerInfo;
  model?: string;
  folderId?: string | null;
}

/**
 * `addIntervention` 결과. Python `task_manager.add_intervention` L590-595 정본 형상.
 *
 * - running 세션 → `{queued: true, queuePosition}` — 현 turn 종료 후 task_executor가 dequeue.
 * - completed/error/interrupted → `{autoResumed: true}` — task_executor.startExecution이
 *   resumeSessionId(task.codexThreadId)로 다음 turn 자동 시작.
 */
export type AddInterventionResult =
  | { queued: true; queuePosition: number }
  | { autoResumed: true };

/** addIntervention이 받는 메시지. dispatcher가 wire payload에서 조립. */
export interface AddInterventionParams {
  agentSessionId: string;
  text: string;
  user: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
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
  ) {}

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
    const task: Task = {
      agentSessionId: params.agentSessionId,
      prompt: params.prompt,
      status: "running",
      profileId: params.profileId,
      callerSessionId: params.callerSessionId ?? undefined,
      callerInfo: params.callerInfo,
      model: params.model,
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
      sessionType: "claude",  // 컬럼 의미는 LLM proxy 분리용. codex backend는 sessions.agent_id의 AgentProfile.backend로 식별.
      prompt: task.prompt,
      clientId: null,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.createdAt,
      callerSessionId: task.callerSessionId ?? null,
    });

    this.tasks.set(task.agentSessionId, task);

    // 폴더 배정 + catalog_updated broadcast (Python `task_manager.py:284-323`
    // `_assign_default_folder_and_broadcast` 정본). codex 세션이 dashboard 폴더 트리에서
    // 보이지 않던 결함의 정본 fix — session_register는 folder_id를 받지 않으므로 *별도*
    // session_assign_folder로 박는다. folder_id 미지정 시 session_type 기반 기본 폴더 폴백.
    //
    // 부가 기능 — 실패는 격리 (Python L292-293 코멘트 정합).
    const assignedFolderId = await this._assignFolderAndBroadcastCatalog(
      task.agentSessionId,
      "claude",  // session_type — codex 세션도 "claude" 그룹으로 분류 (task_models 코멘트 정합)
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
   * 메모리/DB는 그대로 둠 — graceful shutdown 후 재시작 시 catch up.
   */
  async shutdown(): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
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
   * Turn 사이 개입 메시지 추가 (B-4, 분석 캐시
   * `20260517-1410-codex-ts-folder-resume-intervene.md` §D-3).
   *
   * Python `service/task_manager.py:563-642 add_intervention` 정본의 codex 적응판.
   *
   * 분기:
   *   - Running: interventionQueue에 push → intervention_sent broadcast → `{queued, queuePosition}`.
   *     현 turn 종료 후 task_executor가 dequeue하여 다음 turn으로 자동 진입.
   *   - Completed/Error/Interrupted: status를 "running"으로 돌리고 queue에 push +
   *     intervention_sent broadcast + onResume 콜백 호출 → `{autoResumed}`. 콜백은 호출자가
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
    const task = this.tasks.get(params.agentSessionId);
    if (!task) {
      throw new Error(`Task not found: ${params.agentSessionId}`);
    }

    const message: InterventionMessage = {
      text: params.text,
      user: params.user,
      callerInfo: params.callerInfo,
      attachmentPaths: params.attachmentPaths,
    };

    // B-5: intervention_sent를 events 테이블에 *영속화*한 뒤 broadcast.
    // Python `task_executor.py:352-389 on_intervention_sent` 정본 정합 — DB persistEvent +
    // wire broadcast 양쪽 수행하여 사용자 발화가 채팅 UI·session history에 모두 표시.
    // persistEvent 실패는 격리 (Python L382-388 try/except 정합).
    const interventionEvent: Record<string, unknown> = {
      type: "intervention_sent",
      user: message.user,
      text: message.text,
      timestamp: Date.now() / 1000,
    };
    if (message.callerInfo) {
      interventionEvent.caller_info = message.callerInfo;
    }
    if (message.attachmentPaths && message.attachmentPaths.length > 0) {
      interventionEvent.attachments = message.attachmentPaths;
    }
    if (this.persistence) {
      try {
        const eventId = await this.persistence.persistEvent(
          task.agentSessionId,
          interventionEvent as SSEEventPayload,
        );
        task.lastEventId = eventId;
        // handleSideEffects가 last_message 갱신 — PREVIEW_FIELD_MAP.intervention_sent="text" 매핑으로 정합.
        await this.persistence.handleSideEffects(
          task.agentSessionId,
          interventionEvent as SSEEventPayload,
          task,
        );
      } catch (err) {
        this.logger.warn(
          { err, sessionId: task.agentSessionId },
          "intervention_sent persistence failed",
        );
      }
    }

    // intervention_sent broadcast — Python 정본 패턴 (큐잉·resume 양쪽에서 발행).
    try {
      await this.broadcaster.emitInterventionSent(task.agentSessionId, message);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "intervention_sent broadcast failed",
      );
    }

    if (task.status === "running") {
      task.interventionQueue.push(message);
      return { queued: true, queuePosition: task.interventionQueue.length };
    }

    // Completed/Error/Interrupted → 자동 resume.
    //
    // P1-1 race 보호 (code-reviewer): turn 종료 후 _finalize의 await 사이에 intervene이
    // 도착할 수 있다. task.status는 "completed"로 박혀 있지만 `task.engine`은 _finalize
    // 마지막 줄(`task.engine = undefined`)에 도달하기 전까지 살아있어, onResume → startExecution이
    // L45 `if (task.engine) throw` 가드에 걸린다. executionPromise를 drain하여 finalize가
    // 끝났음을 보장한 뒤 진행.
    //
    // Python `task_manager.py:438` "락 블록 바깥에서 실행" 주석이 같은 race를 락으로
    // 차단하는 정본. TS는 task별 executionPromise drain으로 의미 등가 처리.
    if (task.executionPromise) {
      try {
        await task.executionPromise;
      } catch {
        // executionPromise는 _consumeEventStream 정상 종료 시 resolve, throw 시 외부 catch에서
        // 잡힌 후 resolve — 어느 경우든 finalize는 완료됨. ignore.
      }
    }

    // 같은 task 인스턴스를 재활용하여 codexThreadId가 보존되도록 한다.
    // status 전환 + queue push 후 onResume 콜백 — 콜백이 startExecution을 호출.
    task.status = "running";
    task.completedAt = undefined;
    task.error = undefined;
    task.result = undefined;
    task.interventionQueue.push(message);

    // engine 인스턴스는 finalize에서 close된 상태 (drain 완료 보장) — task_executor.startExecution이 새 engine 생성.
    onResume(task);
    return { autoResumed: true };
  }
}
