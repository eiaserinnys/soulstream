import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";

import type { StartExecutionCallback } from "./task_intervention_route.js";
import type { TaskManager } from "./task_manager.js";
import type { InterventionMessage, Task } from "./task_models.js";

export const CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE = "claude_runtime_task_followup";
export const MAX_CLAUDE_RUNTIME_FOLLOWUP_ATTEMPT = 3;
export const CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS: Readonly<Record<number, number>> = {
  2: 5_000,
  3: 30_000,
};

export type ClaudeRuntimeFollowupStallReason =
  | "empty_response"
  | "repeated_response";

export interface ClaudeRuntimeTaskFollowupPort {
  collect(task: Task, event: SSEEventPayload): void;
  flush(task: Task): Promise<void>;
  queueFallback(
    task: Task,
    message: InterventionMessage,
    reason: ClaudeRuntimeFollowupStallReason,
  ): Promise<void>;
  cancelScheduledFallback(task: Task, supersedingMessage: InterventionMessage): void;
}

export interface ClaudeRuntimeTaskFollowupDeps {
  taskManager: Pick<TaskManager, "addIntervention">;
  onResume: StartExecutionCallback;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
}

interface ScheduledRuntimeTaskFallback {
  sessionId: string;
  token: symbol;
  promise: Promise<void>;
}

interface PendingRuntimeTaskFollowup {
  taskId: string;
  status?: string;
  outputFile?: string;
  summary?: string;
  description?: string;
  toolUseId?: string;
  error?: string;
  firstSeen: number;
}

const TERMINAL_RUNTIME_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

export class ClaudeRuntimeTaskFollowupController implements ClaudeRuntimeTaskFollowupPort {
  private readonly pendingBySession = new Map<string, Map<string, PendingRuntimeTaskFollowup>>();
  private readonly flushedTaskKeys = new Set<string>();
  private readonly scheduledFallbacks = new Map<string, ScheduledRuntimeTaskFallback>();
  private sequence = 0;

  constructor(private readonly deps: ClaudeRuntimeTaskFollowupDeps) {}

  collect(task: Task, event: SSEEventPayload): void {
    const payload = event as Record<string, unknown>;
    const type = asString(payload.type);
    if (
      type !== "claude_runtime_task_notification" &&
      type !== "claude_runtime_task_updated"
    ) {
      return;
    }

    const taskId = asString(payload.task_id);
    if (!taskId) return;
    const flushTaskKey = buildTaskKey(task.agentSessionId, taskId);
    if (this.flushedTaskKeys.has(flushTaskKey)) return;
    const runtimeTask = task.claudeRuntime?.tasks[taskId];
    const patch = type === "claude_runtime_task_updated"
      ? asRecord(payload.patch) ?? {}
      : {};
    const status = asString(payload.status) ?? asString(patch.status) ?? runtimeTask?.status;
    if (!status || !TERMINAL_RUNTIME_TASK_STATUSES.has(status)) return;
    const isBackgrounded =
      runtimeTask?.isBackgrounded === true || patch.is_backgrounded === true;
    if (!isBackgrounded) return;

    const pending = this.getPendingMap(task.agentSessionId);
    const previous = pending.get(taskId);
    pending.set(taskId, {
      taskId,
      status,
      outputFile:
        asString(payload.output_file) ?? asString(patch.output_file) ??
        runtimeTask?.outputFile ?? previous?.outputFile,
      summary:
        asString(payload.summary) ?? asString(patch.summary) ??
        runtimeTask?.summary ?? previous?.summary,
      description:
        runtimeTask?.description ?? asString(patch.description) ?? previous?.description,
      toolUseId:
        runtimeTask?.toolUseId ?? asString(payload.tool_use_id) ??
        asString(patch.tool_use_id) ?? previous?.toolUseId,
      error:
        asString(payload.error) ?? asString(patch.error) ??
        runtimeTask?.error ?? previous?.error,
      firstSeen: previous?.firstSeen ?? this.sequence++,
    });
  }

  async flush(task: Task): Promise<void> {
    const pending = this.pendingBySession.get(task.agentSessionId);
    if (!pending || pending.size === 0) return;

    const items = Array.from(pending.values()).sort((a, b) => a.firstSeen - b.firstSeen);
    try {
      await this.deps.taskManager.addIntervention(
        {
          agentSessionId: task.agentSessionId,
          text: buildClaudeRuntimeTaskFollowupPrompt(items),
          user: "system",
          callerInfo: { source: "system", display_name: "Soulstream" },
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          followupAttempt: 1,
          followupKey: buildFollowupKey(task.agentSessionId, items),
        },
        this.deps.onResume,
      );
      for (const item of items) {
        pending.delete(item.taskId);
        this.flushedTaskKeys.add(buildTaskKey(task.agentSessionId, item.taskId));
      }
      if (pending.size === 0) {
        this.pendingBySession.delete(task.agentSessionId);
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, taskIds: items.map((item) => item.taskId) },
        "Claude runtime task follow-up intervention failed",
      );
      throw err;
    }
  }

  queueFallback(
    task: Task,
    message: InterventionMessage,
    reason: ClaudeRuntimeFollowupStallReason,
  ): Promise<void> {
    const attempt = (message.followupAttempt ?? 1) + 1;
    const followupKey = message.followupKey ?? `${task.agentSessionId}:attempt:${attempt}`;
    const existing = this.scheduledFallbacks.get(followupKey);
    if (existing) return existing.promise;

    const delayMs = resolveFallbackDelayMs(attempt);
    const token = Symbol(followupKey);
    const executionPromise = task.executionPromise;
    task.pendingClaudeRuntimeFollowupRetry = true;

    const promise = this.deliverFallbackAfterDelay({
      task,
      message,
      reason,
      attempt,
      followupKey,
      delayMs,
      token,
      executionPromise,
    }).finally(() => {
      if (this.scheduledFallbacks.get(followupKey)?.token === token) {
        this.scheduledFallbacks.delete(followupKey);
      }
      if (!this.hasScheduledFallback(task.agentSessionId)) {
        task.pendingClaudeRuntimeFollowupRetry = false;
      }
    });
    this.scheduledFallbacks.set(followupKey, {
      sessionId: task.agentSessionId,
      token,
      promise,
    });
    this.deps.logger.info(
      { sessionId: task.agentSessionId, followupKey, attempt, delayMs },
      "Claude runtime task follow-up fallback scheduled after terminal drain",
    );
    return promise;
  }

  cancelScheduledFallback(task: Task, supersedingMessage: InterventionMessage): void {
    if (supersedingMessage.source === CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE) return;

    let cancelled = 0;
    for (const [followupKey, scheduled] of this.scheduledFallbacks) {
      if (scheduled.sessionId !== task.agentSessionId) continue;
      this.scheduledFallbacks.delete(followupKey);
      cancelled += 1;
    }
    if (cancelled === 0) return;

    task.pendingClaudeRuntimeFollowupRetry = false;
    this.deps.logger.info(
      { sessionId: task.agentSessionId, cancelled },
      "Claude runtime task follow-up fallback cancelled by a newer message",
    );
  }

  private async deliverFallbackAfterDelay(params: {
    task: Task;
    message: InterventionMessage;
    reason: ClaudeRuntimeFollowupStallReason;
    attempt: number;
    followupKey: string;
    delayMs: number;
    token: symbol;
    executionPromise: Promise<void> | undefined;
  }): Promise<void> {
    const {
      task,
      message,
      reason,
      attempt,
      followupKey,
      delayMs,
      token,
      executionPromise,
    } = params;

    if (executionPromise) {
      try {
        await executionPromise;
      } catch {
        // The executor persists its terminal state before the delayed retry.
      }
    }
    if (!this.isCurrentFallback(followupKey, token)) return;
    await (this.deps.sleep ?? sleep)(delayMs);
    if (!this.isCurrentFallback(followupKey, token)) return;

    task.pendingClaudeRuntimeFollowupRetry = false;
    try {
      const result = await this.deps.taskManager.addIntervention(
        {
          agentSessionId: task.agentSessionId,
          text: buildClaudeRuntimeTaskFollowupFallbackPrompt(message.text, reason),
          user: "system",
          callerInfo: message.callerInfo ?? { source: "system", display_name: "Soulstream" },
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          followupAttempt: attempt,
          followupKey,
          onlyIfTerminal: true,
        },
        this.deps.onResume,
      );
      if ("deferred" in result && result.deferred) {
        this.deps.logger.info(
          { sessionId: task.agentSessionId, followupKey, attempt },
          "Claude runtime task follow-up fallback skipped because another turn is running",
        );
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, followupKey, reason },
        "Claude runtime task follow-up fallback intervention failed",
      );
      throw err;
    }
  }

  private isCurrentFallback(followupKey: string, token: symbol): boolean {
    return this.scheduledFallbacks.get(followupKey)?.token === token;
  }

  private hasScheduledFallback(sessionId: string): boolean {
    return Array.from(this.scheduledFallbacks.values()).some(
      (scheduled) => scheduled.sessionId === sessionId,
    );
  }

  private getPendingMap(sessionId: string): Map<string, PendingRuntimeTaskFollowup> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, PendingRuntimeTaskFollowup>();
    this.pendingBySession.set(sessionId, created);
    return created;
  }
}

function resolveFallbackDelayMs(attempt: number): number {
  const delayMs = CLAUDE_RUNTIME_FOLLOWUP_RETRY_DELAY_MS[attempt];
  if (delayMs === undefined) {
    throw new Error(`No Claude runtime follow-up retry delay configured for attempt ${attempt}`);
  }
  return delayMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function buildClaudeRuntimeTaskFollowupPrompt(
  items: PendingRuntimeTaskFollowup[],
): string {
  const allCompleted = items.every((item) => item.status === "completed");
  const taskLines = items.map((item, index) => {
    const fields = [
      `task_id=${item.taskId}`,
      item.status ? `status=${item.status}` : undefined,
      item.outputFile ? `output_file=${item.outputFile}` : undefined,
      item.summary ? `summary=${item.summary}` : undefined,
      item.description ? `description=${item.description}` : undefined,
      item.toolUseId ? `tool_use_id=${item.toolUseId}` : undefined,
      item.error ? `error=${item.error}` : undefined,
    ].filter(Boolean);
    return `${index + 1}. ${fields.join(" | ")}`;
  });
  const statusNotes = items
    .map((item, index) => formatRuntimeTaskStatusNote(index + 1, item))
    .filter(Boolean);

  return [
    "<claude-runtime-background-task-followup>",
    allCompleted
      ? "백그라운드 Claude runtime task가 완료되었습니다."
      : "백그라운드 Claude runtime task가 종료되었습니다. 일부 항목은 완료되지 않았을 수 있습니다.",
    allCompleted
      ? "아래 완료 항목을 확인하고 사용자가 기대한 다음 작업을 즉시 이어서 진행하세요."
      : "아래 항목의 실제 status를 먼저 확인하고, 완료되지 않은 항목은 필요한 경우 다른 방식으로 작업을 재수립하세요.",
    "output_file이나 summary가 있으면 먼저 읽어 실제 결과를 검증하세요.",
    ...statusNotes,
    "직전 응답을 그대로 반복하지 마세요. 진행할 수 없다면 이유와 필요한 사용자 확인을 명시하세요.",
    "",
    ...taskLines,
    "</claude-runtime-background-task-followup>",
  ].join("\n");
}

function buildClaudeRuntimeTaskFollowupFallbackPrompt(
  originalText: string,
  reason: ClaudeRuntimeFollowupStallReason,
): string {
  const reasonText = reason === "empty_response"
    ? "이전 follow-up turn이 빈 응답으로 끝났습니다."
    : "이전 follow-up turn이 직전 응답을 반복했습니다.";
  return [
    "<claude-runtime-background-task-followup-retry>",
    reasonText,
    "아래 원래 follow-up 지시를 다시 수행하되, 백그라운드 작업의 실제 상태와 output_file/summary를 다시 확인하고 다음 사용자-visible 작업을 이어서 진행하세요.",
    "같은 문장을 반복하지 말고, 진행 불가 시 이유와 필요한 사용자 확인을 명시하세요.",
    "",
    originalText,
    "</claude-runtime-background-task-followup-retry>",
  ].join("\n");
}

function buildFollowupKey(sessionId: string, items: PendingRuntimeTaskFollowup[]): string {
  return `${sessionId}:${items.map((item) => item.taskId).join(",")}`;
}

function buildTaskKey(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}

function formatRuntimeTaskStatusNote(
  index: number,
  item: PendingRuntimeTaskFollowup,
): string | undefined {
  switch (item.status) {
    case "completed":
      return undefined;
    case "failed":
      return `${index}. status=failed 항목은 실패했습니다. error나 output_file이 있으면 원인을 확인한 뒤 재시도 가능 여부를 판단하세요.`;
    case "stopped":
      return `${index}. status=stopped 항목은 완료 전에 중단되었습니다. 결과가 없을 수 있습니다. output_file이나 summary가 있으면 부분 결과만 신뢰하세요.`;
    case "killed":
      return `${index}. status=killed 항목은 완료 전에 강제 종료되었습니다. 결과가 없을 수 있습니다. 턴 종료 teardown 등으로 끊긴 작업은 필요한 경우 다른 방식으로 재수립하세요.`;
    default:
      return item.status
        ? `${index}. status=${item.status} 항목은 완료 여부를 단정하지 말고 실제 결과를 먼저 확인하세요.`
        : undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
