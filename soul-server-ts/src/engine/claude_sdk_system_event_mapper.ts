import { randomUUID } from "node:crypto";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { SOULSTREAM_SCHEDULE_TOOLS } from "./claude_sdk_constants.js";
import {
  asRecord,
  asString,
} from "./claude_sdk_helpers.js";
import { compactMessage } from "./claude_sdk_prompt.js";
import {
  ClaudeRuntimeState,
  parseRuntimeNotificationStatus,
  parseRuntimeSessionState,
  parseRuntimeTaskStatus,
} from "./claude_sdk_runtime_state.js";

type ClaudeSystemMessageMapperContext = {
  runtimeState: ClaudeRuntimeState;
  isBackgroundAgentToolUse(toolUseId: string): boolean;
  rememberBackgroundAgentTask(taskId: string): void;
  isBackgroundAgentTask(taskId: string): boolean;
  hasInterceptedScheduleToolUse(toolUseId: string): boolean;
  consumePendingCompactHookTrigger(trigger: string): boolean;
  makeSubagentStartEvents(
    agentId: string | undefined,
    agentType: string | undefined,
  ): ClaudeClientEvent[];
  makeSubagentStopEvents(agentId: string | undefined): ClaudeClientEvent[];
};

export function mapClaudeSystemMessage(
  message: Record<string, unknown>,
  context: ClaudeSystemMessageMapperContext,
): ClaudeClientEvent[] {
  const subtype = asString(message.subtype);
  if (subtype === "init") {
    const sessionId = asString(message.session_id);
    return sessionId ? [{ type: "session", sessionId }] : [];
  }
  if (subtype === "session_state_changed") {
    const state = parseRuntimeSessionState(message.state);
    if (!state) return [];
    context.runtimeState.setSessionState(state);
    return [
      {
        type: "claude_runtime_session_state",
        state,
        ...(asString(message.session_id) !== undefined
          ? { sessionId: asString(message.session_id) }
          : {}),
      },
    ];
  }
  if (subtype === "away_summary") {
    // Python `message_processor._handle_system_message` L113-120 정합:
    // SystemMessage(subtype="away_summary", data={content: ...}) → AwaySummaryEngineEvent
    const data = asRecord(message.data);
    const content = asString(data?.content);
    return content ? [{ type: "away_summary", content }] : [];
  }
  if (subtype === "compact_boundary") {
    const metadata = asRecord(message.compact_metadata);
    const trigger = asString(metadata?.trigger) ?? "unknown";
    if (context.consumePendingCompactHookTrigger(trigger)) return [];
    return [
      {
        type: "compact",
        trigger,
        message: compactMessage(trigger),
      },
    ];
  }
  if (subtype === "task_started") {
    const taskId = asString(message.task_id);
    if (!taskId) return [];
    context.runtimeState.setTaskStatus(taskId, "running");
    const toolUseId = asString(message.tool_use_id);
    const isBackgroundAgent = toolUseId
      ? context.isBackgroundAgentToolUse(toolUseId)
      : false;
    if (isBackgroundAgent) context.rememberBackgroundAgentTask(taskId);
    const taskType = asString(message.task_type) ?? (isBackgroundAgent ? "agent" : undefined);
    const runtimeEvents: ClaudeClientEvent[] = [
      {
        type: "claude_runtime_task_started",
        taskId,
        ...(asString(message.session_id) !== undefined
          ? { sessionId: asString(message.session_id) }
          : {}),
        ...(toolUseId !== undefined
          ? { toolUseId }
          : {}),
        ...(asString(message.description) !== undefined
          ? { description: asString(message.description) }
          : {}),
        ...(taskType !== undefined
          ? { taskType }
          : {}),
        ...(asString(message.workflow_name) !== undefined
          ? { workflowName: asString(message.workflow_name) }
          : {}),
        ...(asString(message.prompt) !== undefined ? { prompt: asString(message.prompt) } : {}),
        ...(typeof message.skip_transcript === "boolean"
          ? { skipTranscript: message.skip_transcript }
          : {}),
      },
    ];
    if (isBackgroundAgent) {
      runtimeEvents.push({
        type: "claude_runtime_task_updated",
        taskId,
        ...(asString(message.session_id) !== undefined
          ? { sessionId: asString(message.session_id) }
          : {}),
        patch: {
          status: "running",
          is_backgrounded: true,
          task_type: taskType,
          ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
        },
      });
    }
    return [
      ...(isBackgroundAgent ? [] : context.makeSubagentStartEvents(taskId, taskType)),
      ...runtimeEvents,
    ];
  }
  if (subtype === "task_notification") {
    const taskId = asString(message.task_id);
    const status = parseRuntimeNotificationStatus(message.status);
    if (!taskId || !status) return [];
    context.runtimeState.setTaskStatus(taskId, status);
    const isBackgroundAgent = context.isBackgroundAgentTask(taskId);
    return [
      ...(isBackgroundAgent ? [] : context.makeSubagentStopEvents(taskId)),
      {
        type: "claude_runtime_task_notification",
        taskId,
        status,
        ...(asString(message.session_id) !== undefined
          ? { sessionId: asString(message.session_id) }
          : {}),
        ...(asString(message.tool_use_id) !== undefined
          ? { toolUseId: asString(message.tool_use_id) }
          : {}),
        ...(asString(message.output_file) !== undefined
          ? { outputFile: asString(message.output_file) }
          : {}),
        ...(asString(message.summary) !== undefined
          ? { summary: asString(message.summary) }
          : {}),
        ...(message.usage !== undefined ? { usage: message.usage } : {}),
        ...(typeof message.skip_transcript === "boolean"
          ? { skipTranscript: message.skip_transcript }
          : {}),
      },
    ];
  }
  if (subtype === "task_updated") {
    const taskId = asString(message.task_id);
    const patch = asRecord(message.patch) ?? {};
    if (!taskId) return [];
    const status = parseRuntimeTaskStatus(patch.status);
    const existing = context.runtimeState.getTaskStatus(taskId);
    context.runtimeState.setTaskStatus(taskId, status ?? existing ?? "pending");
    return [
      {
        type: "claude_runtime_task_updated",
        taskId,
        patch,
        ...(asString(message.session_id) !== undefined
          ? { sessionId: asString(message.session_id) }
          : {}),
      },
    ];
  }
  if (subtype === "notification") {
    const text = asString(message.text) ?? "";
    const key = asString(message.key);
    const priority = asString(message.priority);
    const prefix = [priority, key].filter(Boolean).join(":");
    const notificationId = asString(message.uuid) ?? key ?? randomUUID();
    const runtimeEvent: ClaudeClientEvent | null = text
      ? {
          type: "claude_runtime_notification",
          notificationId,
          source: "system",
          message: text,
          ...(key !== undefined ? { key } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(asString(message.session_id) !== undefined
            ? { sessionId: asString(message.session_id) }
            : {}),
        }
      : null;
    return text
      ? [
          { type: "debug", message: prefix ? `[${prefix}] ${text}` : text },
          ...(runtimeEvent ? [runtimeEvent] : []),
        ]
      : [];
  }
  if (subtype === "mirror_error") {
    const key = asRecord(message.key);
    const projectKey = asString(key?.projectKey);
    const transcriptSessionId = asString(key?.sessionId);
    const error = asString(message.error);
    if (!projectKey || !transcriptSessionId || !error) return [];
    return [
      {
        type: "claude_runtime_transcript_mirror_error",
        mirrorId: asString(message.uuid) ?? randomUUID(),
        ...(asString(message.session_id) !== undefined
          ? { sessionId: asString(message.session_id) }
          : {}),
        projectKey,
        transcriptSessionId,
        ...(asString(key?.subpath) !== undefined ? { subpath: asString(key?.subpath) } : {}),
        error,
      },
    ];
  }
  if (subtype === "permission_denied") {
    const toolName = asString(message.tool_name) ?? "tool";
    const toolUseId = asString(message.tool_use_id);
    const detail = asString(message.message) ?? "permission denied";
    if (
      (toolUseId && context.hasInterceptedScheduleToolUse(toolUseId))
      || (SOULSTREAM_SCHEDULE_TOOLS.has(toolName)
        && detail.includes("Soulstream durable scheduler"))
    ) {
      return [];
    }
    return [
      {
        type: "error",
        fatal: false,
        errorCode: "permission_denied",
        message: `${toolName}: ${detail}`,
      },
    ];
  }
  if (subtype === "task_progress") {
    const taskId = asString(message.task_id);
    if (taskId) context.runtimeState.setTaskStatus(taskId, "running");
    const summary = asString(message.summary);
    const description = asString(message.description);
    const text = summary ?? description;
    const events: ClaudeClientEvent[] = text ? [{ type: "progress", text }] : [];
    if (taskId) {
      events.push({
        type: "claude_runtime_task_progress",
        taskId,
        ...(asString(message.session_id) !== undefined
          ? { sessionId: asString(message.session_id) }
          : {}),
        ...(asString(message.tool_use_id) !== undefined
          ? { toolUseId: asString(message.tool_use_id) }
          : {}),
        ...(description !== undefined ? { description } : {}),
        ...(message.usage !== undefined ? { usage: message.usage } : {}),
        ...(asString(message.last_tool_name) !== undefined
          ? { lastToolName: asString(message.last_tool_name) }
          : {}),
        ...(summary !== undefined ? { summary } : {}),
      });
    }
    return events;
  }
  if (subtype === "hook_progress") {
    const text = asString(message.output) ?? asString(message.stdout) ?? asString(message.stderr);
    return text ? [{ type: "progress", text }] : [];
  }
  return [];
}
