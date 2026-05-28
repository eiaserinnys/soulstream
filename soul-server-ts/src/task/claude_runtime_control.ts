import { readFile } from "node:fs/promises";

import type { SSEEventPayload, SupportsClaudeBackgroundTasks } from "../engine/protocol.js";
import type { SessionDB } from "../db/session_db.js";

import { applyClaudeRuntimeEvent } from "./claude_runtime_state.js";
import type {
  ClaudeRuntimeState,
  ClaudeRuntimeTaskState,
  ClaudeRuntimeTaskStatus,
  Task,
} from "./task_models.js";

const CLAUDE_RUNTIME_EVENT_TYPES = [
  "claude_runtime_session_state",
  "claude_runtime_task_started",
  "claude_runtime_task_updated",
  "claude_runtime_task_progress",
  "claude_runtime_task_notification",
] as const;

const TERMINAL_STATUSES = new Set<ClaudeRuntimeTaskStatus>([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

const OUTPUT_TRUNCATE_CHARS = 200_000;

export interface ClaudeRuntimeTaskListResult {
  sessionId: string;
  sessionState: ClaudeRuntimeState["sessionState"] | null;
  runtimeSessionId: string | null;
  updatedAt: number | null;
  tasks: ClaudeRuntimeTaskState[];
}

export interface ClaudeRuntimeTaskOutputResult {
  sessionId: string;
  taskId: string;
  task: ClaudeRuntimeTaskState | null;
  output: string;
  outputAvailable: boolean;
  truncated: boolean;
  message?: string;
}

export interface ClaudeRuntimeTaskStopResult {
  sessionId: string;
  taskId: string;
  supported: boolean;
  stopped: boolean;
  alreadyTerminal: boolean;
  status?: string;
  message?: string;
  task: ClaudeRuntimeTaskState | null;
}

export interface ClaudeRuntimeBackgroundTasksResult {
  sessionId: string;
  supported: boolean;
  backgrounded: boolean;
  status?: string;
  message?: string;
}

export function serializeClaudeRuntimeState(
  sessionId: string,
  runtime: ClaudeRuntimeState | undefined,
): ClaudeRuntimeTaskListResult {
  const tasks = Object.values(runtime?.tasks ?? {})
    .map(cloneTask)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    sessionId,
    sessionState: runtime?.sessionState ?? null,
    runtimeSessionId: runtime?.sessionId ?? null,
    updatedAt: runtime?.updatedAt ?? null,
    tasks,
  };
}

export async function loadClaudeRuntimeStateFromEvents(
  db: SessionDB,
  sessionId: string,
): Promise<ClaudeRuntimeState | undefined> {
  const fakeTask = { agentSessionId: sessionId } as Task;
  let cursor = 0;
  for (;;) {
    const events = await db.readEvents(
      sessionId,
      cursor,
      500,
      [...CLAUDE_RUNTIME_EVENT_TYPES],
    );
    if (events.length === 0) break;
    for (const event of events) {
      const payload = {
        ...event.payload,
        type: event.payload.type ?? event.event_type,
      } as SSEEventPayload;
      applyClaudeRuntimeEvent(fakeTask, payload);
      cursor = event.id;
    }
    if (events.length < 500) break;
  }
  return fakeTask.claudeRuntime;
}

export async function readClaudeRuntimeTaskOutput(
  sessionId: string,
  taskId: string,
  task: ClaudeRuntimeTaskState | undefined,
): Promise<ClaudeRuntimeTaskOutputResult> {
  if (!task) {
    return {
      sessionId,
      taskId,
      task: null,
      output: "",
      outputAvailable: false,
      truncated: false,
      message: "Claude runtime task not found",
    };
  }

  if (task.outputFile) {
    try {
      const output = await readFile(task.outputFile, "utf8");
      const truncated = output.length > OUTPUT_TRUNCATE_CHARS;
      return {
        sessionId,
        taskId: task.taskId,
        task: cloneTask(task),
        output: truncated ? output.slice(0, OUTPUT_TRUNCATE_CHARS) : output,
        outputAvailable: true,
        truncated,
      };
    } catch (err) {
      return {
        sessionId,
        taskId: task.taskId,
        task: cloneTask(task),
        output: task.summary ?? "",
        outputAvailable: Boolean(task.summary),
        truncated: false,
        message: `output_file을 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const result: ClaudeRuntimeTaskOutputResult = {
    sessionId,
    taskId: task.taskId,
    task: cloneTask(task),
    output: task.summary ?? "",
    outputAvailable: Boolean(task.summary),
    truncated: false,
  };
  if (!task.summary) {
    result.message = "아직 조회 가능한 출력이 없습니다";
  }
  return result;
}

export function isClaudeRuntimeTaskTerminal(task: ClaudeRuntimeTaskState): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

export function supportsClaudeBackgroundTasks(
  value: unknown,
): value is SupportsClaudeBackgroundTasks {
  const candidate = value as Partial<SupportsClaudeBackgroundTasks> | undefined;
  return (
    typeof candidate?.backgroundClaudeRuntimeTasks === "function" &&
    typeof candidate.stopClaudeRuntimeTask === "function"
  );
}

function cloneTask(task: ClaudeRuntimeTaskState): ClaudeRuntimeTaskState {
  return {
    ...task,
    ...(task.usage ? { usage: { ...task.usage } } : {}),
  };
}
