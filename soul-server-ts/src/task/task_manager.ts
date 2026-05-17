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
  /** B-6 context_builder: 사용자/위임자 system_prompt. folder_prompt와 합성됨. */
  systemPrompt?: string;
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
      systemPrompt: params.systemPrompt,  // B-6 context_builder
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
    if (task.status === "running") {
      return await this._addInterventionRunning(task, message);
    }
    return await this._addInterventionAutoResume(task, message, onResume);
  }

  /**
   * 진행 중 task에 intervention 도착 → intervention_sent 영속화 + broadcast + queue.push.
   *
   * Python `task_executor.py:352-389 on_intervention_sent` 정본. 현 turn 종료 후 task_executor가
   * dequeue하여 다음 turn으로 진입.
   */
  private async _addInterventionRunning(
    task: Task,
    message: InterventionMessage,
  ): Promise<AddInterventionResult> {
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
    try {
      await this.broadcaster.emitInterventionSent(task.agentSessionId, message);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "intervention_sent broadcast failed",
      );
    }
    task.interventionQueue.push(message);
    return { queued: true, queuePosition: task.interventionQueue.length };
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
    // race 보호 — _finalize 미완료 시 await
    if (task.executionPromise) {
      try {
        await task.executionPromise;
      } catch {
        // ignore — finalize는 끝났음
      }
    }

    // user_message 이벤트 wire (Python `_persist_initial_messages` user_message 정합).
    const userMessageEvent: Record<string, unknown> = {
      type: "user_message",
      user: message.user,
      text: message.text,
      timestamp: Date.now() / 1000,
    };
    if (message.callerInfo) {
      userMessageEvent.caller_info = message.callerInfo;
    }
    if (message.attachmentPaths && message.attachmentPaths.length > 0) {
      userMessageEvent.attachments = message.attachmentPaths;
    }
    if (this.persistence) {
      try {
        const eventId = await this.persistence.persistEvent(
          task.agentSessionId,
          userMessageEvent as SSEEventPayload,
        );
        task.lastEventId = eventId;
        await this.persistence.handleSideEffects(
          task.agentSessionId,
          userMessageEvent as SSEEventPayload,
          task,
        );
      } catch (err) {
        this.logger.warn(
          { err, sessionId: task.agentSessionId },
          "user_message (auto-resume) persistence failed",
        );
      }
    }
    try {
      await this.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        userMessageEvent as SSEEventPayload,
      );
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message (auto-resume) broadcast failed",
      );
    }

    // 같은 task 인스턴스를 재활용하여 codexThreadId 보존.
    task.status = "running";
    task.completedAt = undefined;
    task.error = undefined;
    task.result = undefined;
    task.interventionQueue.push(message);

    // 결함 B 정정: session_updated wire를 *상태 전환 직후* broadcast하여 클라이언트의
    // session.status를 "running"으로 즉시 갱신. soul-app TypingIndicator
    // (`session.status === "running"`)가 표시되도록 한다. PR #54까지는 이 wire가 누락되어
    // codex 세션 auto-resume 시 typing indicator가 안 나오던 결함.
    try {
      await this.broadcaster.emitSessionUpdated(task);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_updated (auto-resume) broadcast failed",
      );
    }

    // engine 인스턴스는 finalize에서 close된 상태 — onResume → startExecution이 새 engine 생성.
    onResume(task);
    return { autoResumed: true };
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
   *   - callerInfo: Python은 metadata JSONB array의 첫 caller_info entry 복원 (F-9 fix).
   *     본 PR은 단순화 — callerInfo=undefined. 후속 카드에서 metadata 파싱 추가.
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

    const task: Task = {
      agentSessionId: row.session_id,
      prompt: row.prompt ?? "",
      status: status as TaskStatus,
      profileId: row.agent_id ?? undefined,
      codexThreadId: row.claude_session_id ?? undefined,
      callerSessionId: row.caller_session_id ?? undefined,
      // P0 (code-reviewer): metadata JSONB array에서 *마지막 신원 박힌* caller_info entry 복원.
      // 누락 시 R-2 회로(dashboard owner Google portrait fallback) codex 경로에 재현 —
      // Python `session_eviction_manager.py:148-156` 주석이 명시. Python
      // `extract_caller_info_from_metadata` (`packages/soul-common/.../auth/caller_info.py:119-163`)
      // 정본 인라인 이식.
      callerInfo: extractCallerInfoFromMetadata(row.metadata),
      createdAt: row.created_at,
      completedAt,
      lastEventId: row.last_event_id ?? 0,
      lastReadEventId: row.last_read_event_id ?? 0,
      interventionQueue: [],
    };
    return task;
  }
}

/**
 * Python `IDENTITY_BEARING_SOURCES` 정본(`packages/soul-common/.../auth/caller_info.py:362-370`).
 * 정체성 명시 source는 신원 필드가 비어도 *신원 박힘*으로 간주.
 */
const IDENTITY_BEARING_SOURCES: ReadonlySet<string> = new Set([
  "agent",
  "system",
  "slack",
  "soul-app",
  "channel_observer",
  "trello_watcher",
  "llm",
]);

/** Python `has_caller_identity` 정본 (`auth/caller_info.py:96-116`). */
function hasCallerIdentity(callerInfo: CallerInfo): boolean {
  const source = typeof callerInfo.source === "string" ? callerInfo.source : undefined;
  if (source && IDENTITY_BEARING_SOURCES.has(source)) {
    return true;
  }
  return Boolean(callerInfo.display_name || callerInfo.avatar_url);
}

/**
 * Python `extract_caller_info_from_metadata` 정본 인라인 이식 (R-6 fix, atom G-20).
 *
 * sessions.metadata JSONB array를 순회하여 *마지막 신원 박힌* caller_info entry value 반환.
 * 부재 시 마지막 *어떤* caller_info entry value라도 반환 (graceful — 옛 데이터 보존).
 * caller_info entry 0건이면 undefined.
 *
 * 정책 (Python L132-135 그대로):
 *   1. 마지막 신원 박힌 caller_info entry 우선 (has_caller_identity True)
 *   2. 부재 시 마지막 어떤 caller_info entry
 *   3. metadata에 caller_info entry 0건 → undefined
 */
function extractCallerInfoFromMetadata(metadata: unknown): CallerInfo | undefined {
  if (!Array.isArray(metadata)) return undefined;
  let lastAny: CallerInfo | undefined;
  let lastWithIdentity: CallerInfo | undefined;
  for (const entry of metadata) {
    if (
      !entry ||
      typeof entry !== "object" ||
      (entry as Record<string, unknown>).type !== "caller_info"
    ) {
      continue;
    }
    const value = (entry as Record<string, unknown>).value;
    if (!value || typeof value !== "object") continue;
    const ci = value as CallerInfo;
    lastAny = ci;
    if (hasCallerIdentity(ci)) {
      lastWithIdentity = ci;
    }
  }
  return lastWithIdentity ?? lastAny;
}
