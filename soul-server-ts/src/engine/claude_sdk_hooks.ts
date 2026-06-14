import { randomUUID } from "node:crypto";

import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { GENERIC_HOOK_EVENTS } from "./claude_sdk_constants.js";
import { type EventQueue } from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import {
  asRecord,
  asString,
} from "./claude_sdk_helpers.js";
import {
  compactMessage,
  makeCompactSystemReminder,
} from "./claude_sdk_prompt.js";
import { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";
import { makeGenericHookEvents } from "./claude_sdk_tool_event_mapper.js";

export function buildClaudeSdkHooks(params: {
  output: EventQueue<ClaudeClientEvent>;
  systemPrompt: string[] | undefined;
  eventMapper: ClaudeSdkEventMapper;
  runtimeState: ClaudeRuntimeState;
  logger: Logger;
}): NonNullable<ClaudeSdkOptions["hooks"]> {
  const { output, systemPrompt, eventMapper, runtimeState, logger } = params;
  const compactSystemReminder = makeCompactSystemReminder(systemPrompt);
  const hooks: NonNullable<ClaudeSdkOptions["hooks"]> = {
    PreToolUse: [
      {
        matcher: "Agent",
        hooks: [
          async (input) => {
            const record = asRecord(input);
            eventMapper.rememberBackgroundAgentToolUse(
              asString(record?.tool_use_id),
              asRecord(record?.tool_input),
            );
            return {};
          },
        ],
      },
    ],
    PreCompact: [
      {
        hooks: [
          async (input) => {
            const trigger = asString(asRecord(input)?.trigger) ?? "auto";
            eventMapper.recordCompactHookTrigger(trigger);
            output.push({
              type: "compact",
              trigger,
              message: compactMessage(trigger),
            });
            return {};
          },
        ],
      },
    ],
    SubagentStart: [
      {
        hooks: [
          async (input) => {
            const record = asRecord(input);
            for (const event of eventMapper.makeSubagentStartEvents(
              asString(record?.agent_id),
              asString(record?.agent_type),
            )) {
              output.push(event);
            }
            return {};
          },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          async (input) => {
            const record = asRecord(input);
            for (const event of eventMapper.makeSubagentStopEvents(asString(record?.agent_id))) {
              output.push(event);
            }
            return {};
          },
        ],
      },
    ],
    TaskCreated: [
      {
        hooks: [
          async (input) => {
            const record = asRecord(input);
            const taskId = asString(record?.task_id);
            const subject = asString(record?.task_subject);
            if (!taskId || !subject) return {};
            runtimeState.setTaskStatus(taskId, "pending");
            output.push({
              type: "claude_runtime_task_created",
              taskId,
              subject,
              ...(asString(record?.session_id) !== undefined
                ? { sessionId: asString(record?.session_id) }
                : {}),
              ...(asString(record?.task_description) !== undefined
                ? { description: asString(record?.task_description) }
                : {}),
              ...(asString(record?.teammate_name) !== undefined
                ? { teammateName: asString(record?.teammate_name) }
                : {}),
              ...(asString(record?.team_name) !== undefined
                ? { teamName: asString(record?.team_name) }
                : {}),
            });
            return {};
          },
        ],
      },
    ],
    TaskCompleted: [
      {
        hooks: [
          async (input) => {
            const record = asRecord(input);
            const taskId = asString(record?.task_id);
            const subject = asString(record?.task_subject);
            if (!taskId || !subject) return {};
            runtimeState.setTaskStatus(taskId, "completed");
            output.push({
              type: "claude_runtime_task_completed",
              taskId,
              subject,
              ...(asString(record?.session_id) !== undefined
                ? { sessionId: asString(record?.session_id) }
                : {}),
              ...(asString(record?.task_description) !== undefined
                ? { description: asString(record?.task_description) }
                : {}),
              ...(asString(record?.teammate_name) !== undefined
                ? { teammateName: asString(record?.teammate_name) }
                : {}),
              ...(asString(record?.team_name) !== undefined
                ? { teamName: asString(record?.team_name) }
                : {}),
            });
            return {};
          },
        ],
      },
    ],
    Notification: [
      {
        hooks: [
          async (input) => {
            const record = asRecord(input);
            const title = asString(record?.title) ?? "";
            const message = asString(record?.message) ?? "";
            const notificationType = asString(record?.notification_type) ?? "";
            output.push({
              type: "debug",
              message: `[${notificationType}] ${title}: ${message}`,
            });
            if (message || title) {
              output.push({
                type: "claude_runtime_notification",
                notificationId: asString(record?.uuid) ?? randomUUID(),
                source: "hook",
                message: message || title,
                ...(title ? { title } : {}),
                ...(notificationType ? { notificationType } : {}),
                ...(asString(record?.session_id) !== undefined
                  ? { sessionId: asString(record?.session_id) }
                  : {}),
              });
            }
            return {};
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          async (input) => {
            const record = asRecord(input);
            logger.info(
              {
                stopHookActive: record?.stop_hook_active,
                hasLastAssistantMessage: typeof record?.last_assistant_message === "string",
              },
              "Claude Stop hook fired",
            );
            return {};
          },
        ],
      },
    ],
  };
  for (const hookEventName of GENERIC_HOOK_EVENTS) {
    hooks[hookEventName] = [
      {
        hooks: [
          async (input, toolUseID) => {
            for (const event of makeGenericHookEvents(hookEventName, input, toolUseID)) {
              output.push(event);
            }
            return {};
          },
        ],
      },
    ];
  }
  if (compactSystemReminder) {
    hooks.SessionStart = [
      {
        matcher: "compact",
        hooks: [
          async (input) => {
            const record = asRecord(input);
            if (asString(record?.source) !== "compact") {
              return {};
            }
            return {
              hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: compactSystemReminder,
              },
            };
          },
        ],
      },
    ];
  }
  return hooks;
}
