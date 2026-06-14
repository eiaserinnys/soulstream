import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import type { GenericHookEventName } from "./claude_sdk_constants.js";
import {
  asRecord,
  asString,
} from "./claude_sdk_helpers.js";
import { stripGenericHookOutputFields } from "./claude_sdk_event_mapper_helpers.js";

export function makeNotificationEventFromToolUse(
  input: Record<string, unknown>,
  toolUseId: string,
): ClaudeClientEvent {
  const title = asString(input.title) ?? asString(input.subject);
  const message =
    asString(input.message) ??
    asString(input.body) ??
    asString(input.text) ??
    title ??
    "Claude requested a notification";
  return {
    type: "claude_runtime_notification",
    notificationId: toolUseId,
    source: "tool_use",
    toolUseId,
    message,
    ...(title !== undefined ? { title } : {}),
    ...(asString(input.notification_type) !== undefined
      ? { notificationType: asString(input.notification_type) }
      : {}),
    ...(asString(input.key) !== undefined ? { key: asString(input.key) } : {}),
    ...(asString(input.priority) !== undefined ? { priority: asString(input.priority) } : {}),
  };
}

export function makeRemoteTriggerEventFromToolUse(
  input: Record<string, unknown>,
  toolUseId: string,
): ClaudeClientEvent {
  const prompt = asString(input.prompt) ?? asString(input.message) ?? asString(input.text);
  return {
    type: "claude_runtime_remote_trigger",
    triggerId: toolUseId,
    source: "tool_use",
    toolUseId,
    ...(asString(input.trigger) !== undefined ? { triggerType: asString(input.trigger) } : {}),
    ...(asString(input.type) !== undefined && asString(input.trigger) === undefined
      ? { triggerType: asString(input.type) }
      : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    payload: { ...input },
  };
}

export function makeGenericHookEvents(
  hookEventName: GenericHookEventName,
  input: unknown,
  toolUseID: string | undefined,
): ClaudeClientEvent[] {
  const record = asRecord(input) ?? {};
  const toolUseId = asString(record.tool_use_id) ?? toolUseID;
  const event: ClaudeClientEvent = {
    type: "claude_runtime_hook_event",
    hookEventName,
    ...(asString(record.session_id) !== undefined
      ? { sessionId: asString(record.session_id) }
      : {}),
    ...(asString(record.tool_name) !== undefined ? { toolName: asString(record.tool_name) } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    hookInput: stripGenericHookOutputFields(record),
  };
  const events: ClaudeClientEvent[] = [event];
  if (hookEventName === "WorktreeCreate") {
    events.push({
      type: "claude_runtime_mode_state",
      mode: "worktree",
      active: true,
      source: "hook",
      ...(asString(record.session_id) !== undefined
        ? { sessionId: asString(record.session_id) }
        : {}),
      ...(asString(record.name) !== undefined ? { worktreeName: asString(record.name) } : {}),
    });
  } else if (hookEventName === "WorktreeRemove") {
    events.push({
      type: "claude_runtime_mode_state",
      mode: "worktree",
      active: false,
      source: "hook",
      ...(asString(record.session_id) !== undefined
        ? { sessionId: asString(record.session_id) }
        : {}),
      ...(asString(record.worktree_path) !== undefined
        ? { worktreePath: asString(record.worktree_path) }
        : {}),
    });
  }
  return events;
}

export function makeModeEventsFromToolUse(
  toolName: string,
  toolUseId: string | null,
  toolInput: Record<string, unknown>,
): ClaudeClientEvent[] {
  if (toolName === "EnterPlanMode") {
    return [
      {
        type: "claude_runtime_mode_state",
        mode: "plan",
        active: true,
        source: "tool_use",
        toolName,
        ...(toolUseId !== null ? { toolUseId } : {}),
      },
    ];
  }
  if (toolName === "ExitPlanMode") {
    return [
      {
        type: "claude_runtime_mode_state",
        mode: "plan",
        active: false,
        source: "tool_use",
        toolName,
        ...(toolUseId !== null ? { toolUseId } : {}),
      },
    ];
  }
  if (toolName === "EnterWorktree") {
    return [
      {
        type: "claude_runtime_mode_state",
        mode: "worktree",
        active: true,
        source: "tool_use",
        toolName,
        ...(toolUseId !== null ? { toolUseId } : {}),
        ...(asString(toolInput.name) !== undefined
          ? { worktreeName: asString(toolInput.name) }
          : {}),
        ...(asString(toolInput.path) !== undefined
          ? { worktreePath: asString(toolInput.path) }
          : {}),
      },
    ];
  }
  if (toolName === "ExitWorktree") {
    return [
      {
        type: "claude_runtime_mode_state",
        mode: "worktree",
        active: false,
        source: "tool_use",
        toolName,
        ...(toolUseId !== null ? { toolUseId } : {}),
        ...(asString(toolInput.action) !== undefined
          ? { worktreeAction: asString(toolInput.action) }
          : {}),
      },
    ];
  }
  return [];
}
