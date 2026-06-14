import { randomUUID } from "node:crypto";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeRunOptions } from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { SOULSTREAM_SCHEDULE_TOOLS } from "./claude_sdk_constants.js";
import { type EventQueue } from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { asRecord } from "./claude_sdk_helpers.js";
import {
  makeNotificationEventFromToolUse,
  makeRemoteTriggerEventFromToolUse,
} from "./claude_sdk_tool_event_mapper.js";

const INPUT_REQUEST_TIMEOUT = Symbol("input_request_timeout");
const INPUT_REQUEST_ABORTED = Symbol("input_request_aborted");

type PendingInputRequest = {
  resolve: (
    value: Record<string, unknown> | typeof INPUT_REQUEST_TIMEOUT | typeof INPUT_REQUEST_ABORTED,
  ) => void;
  timeout: NodeJS.Timeout;
};

export class ClaudeSdkToolPermissionController {
  private readonly inputRequestTimeoutMs: number;
  private readonly eventMapper: ClaudeSdkEventMapper;
  private readonly pendingInputRequests = new Map<string, PendingInputRequest>();
  private readonly pendingCanUseToolCalls = new Set<symbol>();

  constructor(params: {
    inputRequestTimeoutMs: number;
    eventMapper: ClaudeSdkEventMapper;
  }) {
    this.inputRequestTimeoutMs = params.inputRequestTimeoutMs;
    this.eventMapper = params.eventMapper;
  }

  deliverInputResponse(requestId: string, answers: Record<string, unknown>): boolean {
    const pending = this.pendingInputRequests.get(requestId);
    if (!pending) return false;
    pending.resolve(answers);
    return true;
  }

  abortPendingInputRequests(): void {
    for (const [requestId, pending] of this.pendingInputRequests) {
      clearTimeout(pending.timeout);
      this.pendingInputRequests.delete(requestId);
      pending.resolve(INPUT_REQUEST_ABORTED);
    }
  }

  clearPerRunState(): void {
    this.abortPendingInputRequests();
    this.pendingCanUseToolCalls.clear();
  }

  makeCanUseTool(
    output: EventQueue<ClaudeClientEvent>,
    options: ClaudeRunOptions,
  ): CanUseTool {
    return async (toolName, input, context) => {
      const pendingToolCall = Symbol(toolName);
      this.pendingCanUseToolCalls.add(pendingToolCall);
      try {
        if (toolName === "PushNotification") {
          output.push(makeNotificationEventFromToolUse(input, context.toolUseID));
          this.eventMapper.markInterceptedScheduleToolUse(context.toolUseID);
          return {
            behavior: "deny",
            message:
              "Soulstream in-app notification captured. External APNs/Expo push is not configured for this runtime.",
            toolUseID: context.toolUseID,
          };
        }

        if (toolName === "RemoteTrigger") {
          output.push(makeRemoteTriggerEventFromToolUse(input, context.toolUseID));
          this.eventMapper.markInterceptedScheduleToolUse(context.toolUseID);
          return {
            behavior: "deny",
            message:
              "Soulstream intervention/capability routing is already the remote trigger path for this session.",
            toolUseID: context.toolUseID,
          };
        }

        if (SOULSTREAM_SCHEDULE_TOOLS.has(toolName)) {
          if (!options.onScheduleToolUse || !options.agentSessionId) {
            return {
              behavior: "deny",
              message: "Soulstream durable scheduler is not configured for this turn.",
              toolUseID: context.toolUseID,
            };
          }
          try {
            const result = await options.onScheduleToolUse({
              agentSessionId: options.agentSessionId,
              toolUseId: context.toolUseID,
              toolName,
              input: asRecord(input) ?? {},
              now: new Date(),
            });
            this.eventMapper.markInterceptedScheduleToolUse(context.toolUseID);
            return {
              behavior: "deny",
              message: result.message,
              toolUseID: context.toolUseID,
            };
          } catch (err) {
            return {
              behavior: "deny",
              message: err instanceof Error ? err.message : String(err),
              toolUseID: context.toolUseID,
            };
          }
        }

        if (toolName !== "AskUserQuestion") {
          return { behavior: "allow", toolUseID: context.toolUseID };
        }

        const requestId = randomUUID().replaceAll("-", "").slice(0, 12);
        const startedAt = Date.now() / 1000;
        const questions = Array.isArray(input.questions) ? input.questions : [];
        output.push({
          type: "input_request",
          requestId,
          toolUseId: context.toolUseID,
          questions,
          startedAt,
          timeoutSec: this.inputRequestTimeoutMs / 1000,
        });

        const response = await this.waitForInputResponse(requestId, context.signal);
        if (response === INPUT_REQUEST_TIMEOUT) {
          output.push({ type: "input_request_expired", requestId });
          return {
            behavior: "deny",
            message: "사용자 응답 대기 시간이 초과되었습니다.",
            toolUseID: context.toolUseID,
          };
        }
        if (response === INPUT_REQUEST_ABORTED) {
          return {
            behavior: "deny",
            message: "사용자 응답 대기가 중단되었습니다.",
            interrupt: true,
            toolUseID: context.toolUseID,
          };
        }

        return {
          behavior: "allow",
          updatedInput: { ...input, answers: response },
          toolUseID: context.toolUseID,
        };
      } finally {
        this.pendingCanUseToolCalls.delete(pendingToolCall);
      }
    };
  }

  private waitForInputResponse(
    requestId: string,
    signal: AbortSignal,
  ): Promise<
    Record<string, unknown> | typeof INPUT_REQUEST_TIMEOUT | typeof INPUT_REQUEST_ABORTED
  > {
    return new Promise((resolve) => {
      let timeout: NodeJS.Timeout;
      const settle = (
        value:
          | Record<string, unknown>
          | typeof INPUT_REQUEST_TIMEOUT
          | typeof INPUT_REQUEST_ABORTED,
      ) => {
        signal.removeEventListener("abort", abort);
        clearTimeout(timeout);
        this.pendingInputRequests.delete(requestId);
        resolve(value);
      };
      const abort = () => settle(INPUT_REQUEST_ABORTED);
      timeout = setTimeout(() => settle(INPUT_REQUEST_TIMEOUT), this.inputRequestTimeoutMs);
      if (signal.aborted) {
        settle(INPUT_REQUEST_ABORTED);
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.pendingInputRequests.set(requestId, {
        resolve: settle,
        timeout,
      });
    });
  }
}
