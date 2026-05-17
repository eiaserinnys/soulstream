/**
 * TaskManager — 세션 task 컬렉션 관리 (Phase B-3).
 *
 * Python `service/task_manager.py`의 *최소* 등가. Codex 단일턴 모델 — Python의
 * intervention_queue, multi-turn, session_eviction은 본 PR 범위 외.
 *
 * 책임:
 *   - createTask: Task 생성 + DB `session_register` + broadcast `session_created`
 *   - getTask / listTasks
 *   - cancelTask: 진행 중 turn abort
 *   - deleteTask: 메모리 + DB + broadcast `session_deleted`
 *
 * 본 PR은 *task lifecycle 메타 관리*만. 실제 *engine 실행*은 TaskExecutor 책임.
 */

import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";

import type { CallerInfo, InterventionMessage, Task, TaskStatus } from "./task_models.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

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

    // broadcast — 실패해도 task는 메모리에 살아있음 (orch 재연결 시 동기 가능)
    try {
      await this.broadcaster.emitSessionCreated(task, params.folderId ?? null);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_created broadcast failed",
      );
    }

    return task;
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

    // intervention_sent broadcast — Python 정본 패턴
    // (`task_executor.py:352-389 on_intervention_sent`). 큐잉·resume 양쪽에서 발행.
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
    // 같은 task 인스턴스를 재활용하여 codexThreadId가 보존되도록 한다.
    // status 전환 + queue push 후 onResume 콜백 — 콜백이 startExecution을 호출.
    task.status = "running";
    task.completedAt = undefined;
    task.error = undefined;
    task.result = undefined;
    task.interventionQueue.push(message);

    // engine 인스턴스는 finalize에서 close된 상태 — task_executor.startExecution이 새 engine 생성.
    onResume(task);
    return { autoResumed: true };
  }
}
