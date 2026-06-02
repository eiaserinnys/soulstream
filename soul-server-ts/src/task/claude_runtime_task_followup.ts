import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";

import type { StartExecutionCallback } from "./task_intervention_route.js";
import type { TaskManager } from "./task_manager.js";
import type { InterventionMessage, Task } from "./task_models.js";

export const CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE = "claude_runtime_task_followup";

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
}

export interface ClaudeRuntimeTaskFollowupDeps {
  taskManager: Pick<TaskManager, "addIntervention">;
  onResume: StartExecutionCallback;
  logger: Logger;
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
    this.pendingBySession.delete(task.agentSessionId);

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
        this.flushedTaskKeys.add(buildTaskKey(task.agentSessionId, item.taskId));
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, taskIds: items.map((item) => item.taskId) },
        "Claude runtime task follow-up intervention failed",
      );
    }
  }

  async queueFallback(
    task: Task,
    message: InterventionMessage,
    reason: ClaudeRuntimeFollowupStallReason,
  ): Promise<void> {
    const attempt = (message.followupAttempt ?? 1) + 1;
    try {
      await this.deps.taskManager.addIntervention(
        {
          agentSessionId: task.agentSessionId,
          text: buildClaudeRuntimeTaskFollowupFallbackPrompt(message.text, reason),
          user: "system",
          callerInfo: message.callerInfo ?? { source: "system", display_name: "Soulstream" },
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          followupAttempt: attempt,
          followupKey: message.followupKey,
        },
        this.deps.onResume,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, followupKey: message.followupKey, reason },
        "Claude runtime task follow-up fallback intervention failed",
      );
    }
  }

  private getPendingMap(sessionId: string): Map<string, PendingRuntimeTaskFollowup> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, PendingRuntimeTaskFollowup>();
    this.pendingBySession.set(sessionId, created);
    return created;
  }
}

export function buildClaudeRuntimeTaskFollowupPrompt(
  items: PendingRuntimeTaskFollowup[],
): string {
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

  return [
    "<claude-runtime-background-task-followup>",
    "백그라운드 Claude runtime task가 완료되었습니다.",
    "아래 완료 항목을 확인하고 사용자가 기대한 다음 작업을 즉시 이어서 진행하세요.",
    "필요하면 output_file을 읽어 결과를 검증하세요.",
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
    "아래 원래 follow-up 지시를 다시 수행하되, 완료된 백그라운드 작업 결과를 확인하고 다음 사용자-visible 작업을 이어서 진행하세요.",
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
