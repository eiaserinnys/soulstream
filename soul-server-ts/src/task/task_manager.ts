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

import type { CallerInfo, Task, TaskStatus } from "./task_models.js";
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
}
