import type { SessionDB } from "../db/session_db.js";
import type { ClaudeSessionRuntimeControl } from "../engine/claude_session_client_registry.js";

import {
  isClaudeRuntimeTaskTerminal,
  loadClaudeRuntimeStateFromEvents,
  readClaudeRuntimeTaskOutput,
  serializeClaudeRuntimeState,
  supportsClaudeBackgroundTasks,
  type ClaudeRuntimeBackgroundTasksResult,
  type ClaudeRuntimeTaskListResult,
  type ClaudeRuntimeTaskOutputResult,
  type ClaudeRuntimeTaskStopResult,
} from "./claude_runtime_control.js";
import type { ClaudeRuntimeState, Task } from "./task_models.js";

interface TaskClaudeRuntimeControlRouteDeps {
  db: SessionDB;
  getTask(sessionId: string): Task | undefined;
  sessionRuntimeControl?: ClaudeSessionRuntimeControl;
}

/**
 * Selects the Claude control owner without reviving a turn-scoped engine.
 *
 * Legacy mode has no sessionRuntimeControl and therefore keeps the original
 * active-engine path. Runtime v2 falls through to the worker registry after the
 * foreground TaskExecutor has released its engine.
 */
export class TaskClaudeRuntimeControlRoute {
  constructor(private readonly deps: TaskClaudeRuntimeControlRouteDeps) {}

  async list(sessionId: string): Promise<ClaudeRuntimeTaskListResult> {
    const runtime = await this.resolveState(sessionId);
    return serializeClaudeRuntimeState(sessionId, runtime);
  }

  async output(
    sessionId: string,
    taskId: string,
  ): Promise<ClaudeRuntimeTaskOutputResult> {
    const runtime = await this.resolveState(sessionId);
    return await readClaudeRuntimeTaskOutput(
      sessionId,
      taskId,
      runtime?.tasks[taskId],
    );
  }

  async stopClaudeRuntimeTask(
    sessionId: string,
    taskId: string,
  ): Promise<ClaudeRuntimeTaskStopResult> {
    const runtime = await this.resolveState(sessionId);
    const runtimeTask = runtime?.tasks[taskId];
    if (runtimeTask && isClaudeRuntimeTaskTerminal(runtimeTask)) {
      return {
        sessionId,
        taskId,
        supported: true,
        stopped: false,
        alreadyTerminal: true,
        status: "already_terminal",
        task: runtimeTask,
      };
    }

    const activeEngine = this.deps.getTask(sessionId)?.engine;
    const result =
      activeEngine && supportsClaudeBackgroundTasks(activeEngine)
        ? await activeEngine.stopClaudeRuntimeTask(taskId)
        : await this.stopThroughRegistry(sessionId, taskId);
    return {
      sessionId,
      taskId,
      supported: result.status !== "not_supported",
      stopped: result.status === "ok",
      alreadyTerminal: false,
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
      task: runtimeTask ?? null,
    };
  }

  async backgroundClaudeRuntimeTasks(
    sessionId: string,
    toolUseId?: string,
  ): Promise<ClaudeRuntimeBackgroundTasksResult> {
    await this.resolveState(sessionId);
    const activeEngine = this.deps.getTask(sessionId)?.engine;
    const result =
      activeEngine && supportsClaudeBackgroundTasks(activeEngine)
        ? await activeEngine.backgroundClaudeRuntimeTasks(toolUseId)
        : await this.backgroundThroughRegistry(sessionId, toolUseId);
    return {
      sessionId,
      supported: result.status !== "not_supported",
      backgrounded: result.status === "ok",
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
    };
  }

  private async stopThroughRegistry(sessionId: string, taskId: string) {
    const control = this.deps.sessionRuntimeControl;
    if (!control?.has(sessionId)) return notSupported();
    return await control.stopClaudeRuntimeTask(sessionId, taskId);
  }

  private async backgroundThroughRegistry(sessionId: string, toolUseId?: string) {
    const control = this.deps.sessionRuntimeControl;
    if (!control?.has(sessionId)) return notSupported();
    return await control.backgroundClaudeRuntimeTasks(sessionId, toolUseId);
  }

  private async resolveState(sessionId: string): Promise<ClaudeRuntimeState | undefined> {
    const activeTask = this.deps.getTask(sessionId);
    if (activeTask?.claudeRuntime) return activeTask.claudeRuntime;
    const session = await this.deps.db.getSession(sessionId);
    if (!session) throw new Error(`Task not found: ${sessionId}`);
    return await loadClaudeRuntimeStateFromEvents(this.deps.db, sessionId);
  }
}

function notSupported() {
  return {
    status: "not_supported" as const,
    message: "세션의 active Claude runtime이 background task control을 지원하지 않습니다",
  };
}
