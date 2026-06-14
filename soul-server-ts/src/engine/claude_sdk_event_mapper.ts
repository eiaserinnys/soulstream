import { randomUUID } from "node:crypto";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { mapClaudeSystemMessage } from "./claude_sdk_system_event_mapper.js";
import {
  coerceResetsAt,
  extractBackgroundBashOutput,
  makeContextUsageEvent,
  messageContent,
  permissionDenialsToStrings,
  userMessageText,
} from "./claude_sdk_event_mapper_helpers.js";
import { makeModeEventsFromToolUse } from "./claude_sdk_tool_event_mapper.js";
import {
  asArray,
  asNullableString,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  firstString,
} from "./claude_sdk_helpers.js";
import {
  isRecoverableExecutionDiagnostic,
  resultErrorCode,
} from "./claude_sdk_diagnostics.js";
import { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";

export class ClaudeSdkEventMapper {
  private readonly runtimeState: ClaudeRuntimeState;
  private readonly toolNamesById = new Map<string, string>();
  private readonly emittedToolResultIds = new Set<string>();
  private readonly interceptedScheduleToolUseIds = new Set<string>();
  private readonly backgroundAgentToolUseIds = new Set<string>();
  private readonly backgroundAgentTaskIds = new Set<string>();
  private readonly emittedSubagentStartIds = new Set<string>();
  private readonly emittedSubagentStopIds = new Set<string>();
  private readonly pendingCompactHookTriggers: string[] = [];
  private compactHookEventCount = 0;

  constructor(runtimeState: ClaudeRuntimeState) {
    this.runtimeState = runtimeState;
  }

  clearPerRunState(): void {
    this.toolNamesById.clear();
    this.emittedToolResultIds.clear();
    this.emittedSubagentStartIds.clear();
    this.emittedSubagentStopIds.clear();
    this.interceptedScheduleToolUseIds.clear();
    this.backgroundAgentToolUseIds.clear();
    this.backgroundAgentTaskIds.clear();
    this.pendingCompactHookTriggers.length = 0;
    this.compactHookEventCount = 0;
  }

  getCompactHookEventCount(): number {
    return this.compactHookEventCount;
  }

  recordCompactHookTrigger(trigger: string): void {
    this.compactHookEventCount += 1;
    this.pendingCompactHookTriggers.push(trigger);
  }

  markInterceptedScheduleToolUse(toolUseId: string): void {
    this.interceptedScheduleToolUseIds.add(toolUseId);
  }

  mapSdkMessage(message: SDKMessage): ClaudeClientEvent[] {
    const msg = asRecord(message);
    if (!msg) return [];

    switch (msg.type) {
      case "system":
        return this.mapSystemMessage(msg);
      case "assistant":
        return this.mapAssistantMessage(msg);
      case "user":
        return this.mapUserMessage(msg);
      case "result":
        return this.mapResultMessage(msg);
      case "prompt_suggestion":
        return this.mapPromptSuggestion(msg);
      case "rate_limit_event":
        return this.mapRateLimit(msg);
      default:
        return [];
    }
  }

  mapSystemMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    return mapClaudeSystemMessage(message, {
      runtimeState: this.runtimeState,
      isBackgroundAgentToolUse: (toolUseId) => this.backgroundAgentToolUseIds.has(toolUseId),
      rememberBackgroundAgentTask: (taskId) => this.backgroundAgentTaskIds.add(taskId),
      isBackgroundAgentTask: (taskId) => this.backgroundAgentTaskIds.has(taskId),
      hasInterceptedScheduleToolUse: (toolUseId) => this.interceptedScheduleToolUseIds.has(toolUseId),
      consumePendingCompactHookTrigger: (trigger) => this.consumePendingCompactHookTrigger(trigger),
      makeSubagentStartEvents: (agentId, agentType) =>
        this.makeSubagentStartEvents(agentId, agentType),
      makeSubagentStopEvents: (agentId) => this.makeSubagentStopEvents(agentId),
    });
  }

  mapAssistantMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const events: ClaudeClientEvent[] = [];
    const error = asString(message.error);
    if (error) {
      // Python `message_processor._handle_assistant_message` L172-187 정합:
      // AssistantMessage.error는 별 `assistant_error` 이벤트로 발행하여 dashboard가
      // authentication_failed / billing_error / rate_limit 등을 구분 표시 가능.
      // 기존 generic `error{fatal:false}` 패스는 *완전 교체* — permission_denied 분기
      // (mapSystemMessage L394-403)는 별 카테고리라 그대로 유지.
      const nested = asRecord(message.message);
      const model = asString(message.model) ?? asString(nested?.model);
      const messageId = asString(message.message_id) ?? asString(nested?.id);
      events.push({
        type: "assistant_error",
        errorType: error,
        ...(model !== undefined ? { model } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
      });
    }

    const content = messageContent(message);
    for (const block of content) {
      const record = asRecord(block);
      if (!record) continue;

      if (record.type === "text") {
        const text = asString(record.text);
        if (text) events.push({ type: "text", text });
        continue;
      }
      if (record.type === "thinking") {
        const thinking = asString(record.thinking);
        if (thinking) {
          events.push({
            type: "thinking",
            thinking,
            ...(asString(record.signature) ? { signature: asString(record.signature) } : {}),
          });
        }
        continue;
      }
      if (record.type === "tool_use") {
        const toolUseId = asString(record.id) ?? null;
        const toolName = asString(record.name) ?? "tool";
        if (toolUseId) this.toolNamesById.set(toolUseId, toolName);
        const toolInput = asRecord(record.input) ?? {};
        if (toolName === "Agent") this.rememberBackgroundAgentToolUse(toolUseId, toolInput);
        events.push({
          type: "tool_start",
          toolName,
          toolInput,
          toolUseId,
        });
        events.push(...makeModeEventsFromToolUse(toolName, toolUseId, toolInput));
      }
    }

    return events;
  }

  mapUserMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const events: ClaudeClientEvent[] = [];
    const remoteTrigger = this.mapRemoteOriginUserMessage(message);
    if (remoteTrigger) events.push(remoteTrigger);
    const content = messageContent(message);
    for (const block of content) {
      const record = asRecord(block);
      if (!record || record.type !== "tool_result") continue;

      const toolUseId = asString(record.tool_use_id) ?? null;
      if (toolUseId && this.interceptedScheduleToolUseIds.has(toolUseId)) continue;
      if (toolUseId && this.emittedToolResultIds.has(toolUseId)) continue;
      if (toolUseId) this.emittedToolResultIds.add(toolUseId);
      const toolName = toolUseId ? this.toolNamesById.get(toolUseId) : undefined;
      events.push({
        type: "tool_result",
        toolName,
        toolUseId,
        result: record.content,
        isError: Boolean(record.is_error),
      });
      events.push(
        ...this.mapBackgroundBashTaskFromToolResult({
          toolName,
          toolUseId,
          content: [record.content, message.tool_use_result],
        }),
      );
    }
    return events;
  }

  mapResultMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const success = message.subtype === "success" && message.is_error !== true;
    const output = success
      ? asString(message.result) ?? ""
      : firstString(asArray(message.errors)) ??
        asString(message.result) ??
        asString(message.subtype) ??
        "";
    const resultEvent: ClaudeClientEvent = {
      type: "result",
      success,
      output,
      error: success ? null : output,
      usage: message.usage,
      totalCostUsd: asNumber(message.total_cost_usd) ?? null,
      stopReason: asNullableString(message.stop_reason),
      terminalReason: asNullableString(message.terminal_reason),
      errors: asStringArray(message.errors),
      modelUsage: asRecord(message.modelUsage),
      permissionDenials: permissionDenialsToStrings(message.permission_denials),
    };
    const contextUsageEvent = makeContextUsageEvent(message.usage);

    if (!success) {
      const errorEvent: ClaudeClientEvent = {
        type: "error",
        message: output || "Claude SDK result indicated failure",
        fatal: !isRecoverableExecutionDiagnostic(message),
        errorCode: resultErrorCode(message),
      };
      return [
        resultEvent,
        ...(contextUsageEvent ? [contextUsageEvent] : []),
        errorEvent,
      ];
    }

    const completeEvent: ClaudeClientEvent = {
      type: "complete",
      result: output,
      claudeSessionId: asString(message.session_id),
      usage: message.usage,
      ...(asNumber(message.total_cost_usd) !== undefined
        ? { totalCostUsd: asNumber(message.total_cost_usd) }
        : {}),
    };
    return [
      resultEvent,
      ...(contextUsageEvent ? [contextUsageEvent] : []),
      completeEvent,
    ];
  }

  mapPromptSuggestion(message: Record<string, unknown>): ClaudeClientEvent[] {
    const text = asString(message.suggestion)?.trim();
    return text ? [{ type: "prompt_suggestion", text }] : [];
  }

  mapRateLimit(message: Record<string, unknown>): ClaudeClientEvent[] {
    const info = asRecord(message.rate_limit_info);
    if (!info) return [];
    // Defensive parser — SDK 0.2.x 타입은 camelCase(resetsAt/rateLimitType)이나
    // Python wire 또는 fixture에서 snake_case가 들어올 수 있음. ISO string도 그대로 수용.
    const resetsAtRaw = info.resetsAt ?? info.resets_at;
    const rateLimitTypeRaw = asString(info.rateLimitType) ?? asString(info.rate_limit_type);
    return [
      {
        type: "rate_limit",
        status: asString(info.status),
        resetsAt: coerceResetsAt(resetsAtRaw),
        rateLimitType: rateLimitTypeRaw,
        utilization: asNumber(info.utilization),
      },
    ];
  }

  makeSubagentStartEvents(
    agentId: string | undefined,
    agentType: string | undefined,
  ): ClaudeClientEvent[] {
    if (this.isBackgroundAgentIdentifier(agentId)) return [];
    if (!agentId || this.emittedSubagentStartIds.has(agentId)) return [];
    this.emittedSubagentStartIds.add(agentId);
    return [
      {
        type: "subagent_start",
        agentId,
        agentType: agentType ?? "task",
      },
    ];
  }

  makeSubagentStopEvents(agentId: string | undefined): ClaudeClientEvent[] {
    if (this.isBackgroundAgentIdentifier(agentId)) return [];
    if (!agentId || this.emittedSubagentStopIds.has(agentId)) return [];
    this.emittedSubagentStopIds.add(agentId);
    return [{ type: "subagent_stop", agentId }];
  }

  rememberBackgroundAgentToolUse(
    toolUseId: string | undefined | null,
    toolInput: Record<string, unknown> | undefined,
  ): void {
    if (toolUseId && toolInput?.run_in_background === true) {
      this.backgroundAgentToolUseIds.add(toolUseId);
    }
  }

  private mapRemoteOriginUserMessage(message: Record<string, unknown>): ClaudeClientEvent | null {
    const origin = asRecord(message.origin);
    const kind = asString(origin?.kind);
    if (!origin || !kind || kind === "human") return null;
    const prompt = userMessageText(message);
    return {
      type: "claude_runtime_remote_trigger",
      triggerId: asString(message.uuid) ?? randomUUID(),
      source: "message_origin",
      ...(asString(message.session_id) !== undefined
        ? { sessionId: asString(message.session_id) }
        : {}),
      originKind: kind,
      ...(asString(origin.from) !== undefined ? { originFrom: asString(origin.from) } : {}),
      ...(asString(origin.name) !== undefined ? { originName: asString(origin.name) } : {}),
      ...(asString(origin.server) !== undefined ? { originServer: asString(origin.server) } : {}),
      ...(asString(message.priority) !== undefined ? { priority: asString(message.priority) } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    };
  }

  private mapBackgroundBashTaskFromToolResult(params: {
    toolName?: string;
    toolUseId: string | null;
    content: unknown;
  }): ClaudeClientEvent[] {
    const background = extractBackgroundBashOutput(params.content);
    if (!background.taskId) return [];
    if (params.toolName && params.toolName !== "Bash" && params.toolName !== "bash") {
      return [];
    }

    const patch: Record<string, unknown> = {
      status: "running",
      is_backgrounded: true,
      task_type: "bash",
    };
    if (params.toolUseId) patch.tool_use_id = params.toolUseId;
    if (background.outputFile) patch.output_file = background.outputFile;

    const existing = this.runtimeState.getTaskStatus(background.taskId);
    this.runtimeState.setTaskStatus(background.taskId, existing ?? "running");

    const updateEvent: ClaudeClientEvent = {
      type: "claude_runtime_task_updated",
      taskId: background.taskId,
      patch,
    };
    if (existing) return [updateEvent];
    return [
      {
        type: "claude_runtime_task_started",
        taskId: background.taskId,
        ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
        taskType: "bash",
        description: "Background Bash task",
      },
      updateEvent,
    ];
  }

  private isBackgroundAgentIdentifier(agentId: string | undefined): boolean {
    return !!agentId && (
      this.backgroundAgentTaskIds.has(agentId) ||
      this.backgroundAgentToolUseIds.has(agentId)
    );
  }

  private consumePendingCompactHookTrigger(trigger: string): boolean {
    const index = this.pendingCompactHookTriggers.indexOf(trigger);
    if (index === -1) return false;
    this.pendingCompactHookTriggers.splice(index, 1);
    return true;
  }
}
