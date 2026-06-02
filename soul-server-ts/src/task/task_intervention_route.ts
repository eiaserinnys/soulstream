import type { AutoResumeCallback, AutoResumeTransition } from "./task_auto_resume_transition.js";
import type { ActiveTaskRecovery } from "./task_active_recovery.js";
import type { CallerInfo, InterventionMessage, Task } from "./task_models.js";
import type {
  RunningInterventionResult,
  RunningInterventionTransition,
} from "./task_running_intervention_transition.js";

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
  source?: string;
  followupAttempt?: number;
  followupKey?: string;
  /**
   * Scheduler dispatch must not rely on the in-memory fallback queue. When false,
   * a running task that cannot be live-steered returns `{deferred: true}` so the
   * caller can keep its durable store active and retry later.
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
  activeTaskRecovery: Pick<ActiveTaskRecovery, "prepareForIntervention">;
  runningInterventionTransition: Pick<RunningInterventionTransition, "deliver">;
  autoResumeTransition: Pick<AutoResumeTransition, "resume">;
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
    const task = await this.resolveTask(params.agentSessionId);
    const message: InterventionMessage = {
      text: params.text,
      user: params.user,
      callerInfo: params.callerInfo,
      attachmentPaths: params.attachmentPaths,
      source: params.source,
      followupAttempt: params.followupAttempt,
      followupKey: params.followupKey,
    };

    if (this.deps.activeTaskRecovery.prepareForIntervention(task) === "running") {
      return await this.deps.runningInterventionTransition.deliver(task, message, {
        queueIfUndelivered: params.queueIfRunning ?? true,
      });
    }
    return await this.deps.autoResumeTransition.resume(task, message, onResume);
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
