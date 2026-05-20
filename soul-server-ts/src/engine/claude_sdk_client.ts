import { randomUUID } from "node:crypto";

import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeClient, ClaudeRunOptions } from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";

const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";
const DEFAULT_INPUT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_INTERVENTION_POLL_INTERVAL_MS = 1_000;
const INPUT_REQUEST_TIMEOUT = Symbol("input_request_timeout");
const INPUT_REQUEST_ABORTED = Symbol("input_request_aborted");

export type ClaudeSdkQueryParams = {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeSdkOptions;
};

export type ClaudeSdkQueryFn = (params: ClaudeSdkQueryParams) => ClaudeSdkQuery;

export interface ClaudeSdkClientConfig {
  query?: ClaudeSdkQueryFn;
  inputRequestTimeoutMs?: number;
  interventionPollIntervalMs?: number;
}

type PendingInputRequest = {
  resolve: (
    value: Record<string, unknown> | typeof INPUT_REQUEST_TIMEOUT | typeof INPUT_REQUEST_ABORTED,
  ) => void;
  timeout: NodeJS.Timeout;
};

type EventQueue<T> = AsyncIterableIterator<T> & {
  push(value: T): boolean;
  close(): void;
  fail(err: unknown): void;
};

export class ClaudeSdkClient implements ClaudeClient {
  private readonly queryFn: ClaudeSdkQueryFn;
  private readonly logger: Logger;
  private readonly inputRequestTimeoutMs: number;
  private readonly interventionPollIntervalMs: number;
  private readonly pendingInputRequests = new Map<string, PendingInputRequest>();
  private readonly toolNamesById = new Map<string, string>();
  private readonly emittedToolResultIds = new Set<string>();

  private activeQuery: ClaudeSdkQuery | null = null;
  private activeInput: PushAsyncIterable<SDKUserMessage> | null = null;
  private lastWorkspaceDir: string | null = null;
  private lastEnv: Record<string, string> | null = null;

  constructor(config: ClaudeSdkClientConfig = {}, logger: Logger) {
    this.queryFn = config.query ?? defaultQuery;
    this.logger = logger;
    this.inputRequestTimeoutMs =
      config.inputRequestTimeoutMs ?? DEFAULT_INPUT_REQUEST_TIMEOUT_MS;
    this.interventionPollIntervalMs =
      config.interventionPollIntervalMs ?? DEFAULT_INTERVENTION_POLL_INTERVAL_MS;
  }

  async *run(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent> {
    this.lastWorkspaceDir = options.workspaceDir;
    this.lastEnv = options.env;
    this.clearPerRunState();

    const output = createEventQueue<ClaudeClientEvent>();
    const input = new PushAsyncIterable<SDKUserMessage>();
    input.push(makeUserMessage(options.prompt));
    this.activeInput = input;

    const abortController = new AbortController();
    const abortSdk = () => abortController.abort(signal.reason);
    if (signal.aborted) {
      abortSdk();
    } else {
      signal.addEventListener("abort", abortSdk, { once: true });
    }

    const pollController = new AbortController();
    const queryOptions = this.buildSdkOptions(options, abortController, output);
    let query: ClaudeSdkQuery;
    try {
      query = this.queryFn({ prompt: input, options: queryOptions });
    } catch (err) {
      signal.removeEventListener("abort", abortSdk);
      input.close();
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    }
    this.activeQuery = query;
    const pump = this.pumpQuery(query, output);

    if (options.onIntervention) {
      this.startInterventionPolling(options.onIntervention, input, pollController.signal);
    }

    try {
      for await (const event of output) {
        yield event;
      }
      await pump;
    } catch (err) {
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    } finally {
      signal.removeEventListener("abort", abortSdk);
      pollController.abort();
      input.close();
      if (this.activeInput === input) this.activeInput = null;
      if (this.activeQuery === query) this.activeQuery = null;
      this.abortPendingInputRequests();
      await pump.catch(() => undefined);
    }
  }

  async compact(sessionId: string): Promise<void> {
    if (!this.lastWorkspaceDir || !this.lastEnv) {
      throw new Error("ClaudeSdkClient.compact requires a previous run context");
    }

    const controller = new AbortController();
    const input = new PushAsyncIterable<SDKUserMessage>();
    input.push(makeUserMessage("/compact"));
    input.close();
    const output = createEventQueue<ClaudeClientEvent>();
    const queryOptions = this.buildSdkOptions(
      {
        prompt: "/compact",
        workspaceDir: this.lastWorkspaceDir,
        resumeSessionId: sessionId,
        env: this.lastEnv,
      },
      controller,
      output,
    );
    let query: ClaudeSdkQuery;
    try {
      query = this.queryFn({ prompt: input, options: queryOptions });
    } catch (err) {
      input.close();
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    }
    this.activeQuery = query;

    try {
      for await (const _ of query) {
        // Compact is a control action; callers only need completion/failure.
      }
    } catch (err) {
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    } finally {
      input.close();
      if (this.activeQuery === query) this.activeQuery = null;
    }
  }

  deliverInputResponse(requestId: string, answers: Record<string, unknown>): boolean {
    const pending = this.pendingInputRequests.get(requestId);
    if (!pending) return false;
    pending.resolve(answers);
    return true;
  }

  async interrupt(): Promise<boolean> {
    const query = this.activeQuery;
    if (!query) return false;
    try {
      await query.interrupt();
    } catch (err) {
      this.logger.warn({ err }, "Claude SDK interrupt failed; closing query");
      query.close();
    }
    this.abortPendingInputRequests();
    return true;
  }

  async close(): Promise<void> {
    this.activeInput?.close();
    this.activeQuery?.close();
    this.abortPendingInputRequests();
  }

  private buildSdkOptions(
    options: ClaudeRunOptions,
    abortController: AbortController,
    output: EventQueue<ClaudeClientEvent>,
  ): ClaudeSdkOptions {
    const executablePath = options.env[CLAUDE_CODE_EXECPATH_ENV]?.trim();
    return {
      abortController,
      cwd: options.workspaceDir,
      env: options.env,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
      promptSuggestions: true,
      includePartialMessages: false,
      toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
      canUseTool: this.makeCanUseTool(output),
      ...(options.model ? { model: options.model } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
      ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
    };
  }

  private makeCanUseTool(output: EventQueue<ClaudeClientEvent>): CanUseTool {
    return async (toolName, input, context) => {
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

  private async pumpQuery(
    query: ClaudeSdkQuery,
    output: EventQueue<ClaudeClientEvent>,
  ): Promise<void> {
    try {
      for await (const message of query) {
        let shouldStop = false;
        for (const event of this.mapSdkMessage(message)) {
          output.push(event);
          if (event.type === "complete" || (event.type === "error" && event.fatal !== false)) {
            shouldStop = true;
          }
        }
        if (shouldStop) {
          query.close();
          output.close();
          return;
        }
      }
      output.close();
    } catch (err) {
      output.fail(err);
      throw err;
    }
  }

  private startInterventionPolling(
    onIntervention: () => Promise<string | null>,
    input: PushAsyncIterable<SDKUserMessage>,
    signal: AbortSignal,
  ): void {
    void (async () => {
      while (!signal.aborted) {
        await sleep(this.interventionPollIntervalMs, signal);
        if (signal.aborted) break;

        try {
          const text = await onIntervention();
          if (text) input.push(makeUserMessage(text));
        } catch (err) {
          this.logger.warn({ err }, "Claude intervention poll failed");
        }
      }
    })();
  }

  private mapSdkMessage(message: SDKMessage): ClaudeClientEvent[] {
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

  private mapSystemMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const subtype = asString(message.subtype);
    if (subtype === "init") {
      const sessionId = asString(message.session_id);
      return sessionId ? [{ type: "session", sessionId }] : [];
    }
    if (subtype === "compact_boundary") {
      const metadata = asRecord(message.compact_metadata);
      const trigger = asString(metadata?.trigger) ?? "unknown";
      return [
        {
          type: "compact",
          trigger,
          message: `Claude session compacted (${trigger})`,
        },
      ];
    }
    if (subtype === "task_started") {
      const agentId = asString(message.task_id);
      if (!agentId) return [];
      return [
        {
          type: "subagent_start",
          agentId,
          agentType: asString(message.task_type) ?? "task",
        },
      ];
    }
    if (subtype === "task_notification") {
      const agentId = asString(message.task_id);
      if (!agentId) return [];
      return [{ type: "subagent_stop", agentId }];
    }
    if (subtype === "permission_denied") {
      const toolName = asString(message.tool_name) ?? "tool";
      const detail = asString(message.message) ?? "permission denied";
      return [
        {
          type: "error",
          fatal: false,
          errorCode: "permission_denied",
          message: `${toolName}: ${detail}`,
        },
      ];
    }
    return [];
  }

  private mapAssistantMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const events: ClaudeClientEvent[] = [];
    const error = asString(message.error);
    if (error) {
      events.push({
        type: "error",
        message: `Claude assistant error: ${error}`,
        errorCode: error,
        fatal: false,
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
        events.push({
          type: "tool_start",
          toolName,
          toolInput: asRecord(record.input) ?? {},
          toolUseId,
        });
      }
    }

    return events;
  }

  private mapUserMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const events: ClaudeClientEvent[] = [];
    const content = messageContent(message);
    for (const block of content) {
      const record = asRecord(block);
      if (!record || record.type !== "tool_result") continue;

      const toolUseId = asString(record.tool_use_id) ?? null;
      if (toolUseId && this.emittedToolResultIds.has(toolUseId)) continue;
      if (toolUseId) this.emittedToolResultIds.add(toolUseId);
      events.push({
        type: "tool_result",
        toolName: toolUseId ? this.toolNamesById.get(toolUseId) : undefined,
        toolUseId,
        result: record.content,
        isError: Boolean(record.is_error),
      });
    }
    return events;
  }

  private mapResultMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
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
      errors: asStringArray(message.errors),
      modelUsage: asRecord(message.modelUsage),
      permissionDenials: permissionDenialsToStrings(message.permission_denials),
    };

    if (!success) {
      return [
        resultEvent,
        {
          type: "error",
          message: output || "Claude SDK result indicated failure",
          fatal: true,
          errorCode: asString(message.subtype),
        },
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
    return [resultEvent, completeEvent];
  }

  private mapPromptSuggestion(message: Record<string, unknown>): ClaudeClientEvent[] {
    const text = asString(message.suggestion)?.trim();
    return text ? [{ type: "prompt_suggestion", text }] : [];
  }

  private mapRateLimit(message: Record<string, unknown>): ClaudeClientEvent[] {
    const info = asRecord(message.rate_limit_info);
    if (!info) return [];
    return [
      {
        type: "rate_limit",
        status: asString(info.status),
        resetsAt: epochNumberToIso(asNumber(info.resetsAt)),
        rateLimitType: asString(info.rateLimitType),
        utilization: asNumber(info.utilization),
      },
    ];
  }

  private normalizeExecutionError(err: unknown, executablePath?: string): Error {
    const rawMessage = err instanceof Error ? err.message : String(err);
    if (executablePath && /ENOENT|not found|no such file/i.test(rawMessage)) {
      return new Error(
        `Claude Code executable failed to start at CLAUDE_CODE_EXECPATH: ${rawMessage}`,
      );
    }
    if (/ENOENT|not found|no such file/i.test(rawMessage)) {
      return new Error(`Claude Code executable failed to start: ${rawMessage}`);
    }
    return err instanceof Error ? err : new Error(rawMessage);
  }

  private clearPerRunState(): void {
    this.abortPendingInputRequests();
    this.toolNamesById.clear();
    this.emittedToolResultIds.clear();
  }

  private abortPendingInputRequests(): void {
    for (const [requestId, pending] of this.pendingInputRequests) {
      clearTimeout(pending.timeout);
      this.pendingInputRequests.delete(requestId);
      pending.resolve(INPUT_REQUEST_ABORTED);
    }
  }
}

class PushAsyncIterable<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined as T });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.closed) return { done: true, value: undefined as T };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { done: true, value: undefined as T };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function createEventQueue<T>(): EventQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  let closed = false;
  let failure: unknown;

  const iterator: EventQueue<T> = {
    push(value) {
      if (closed || failure !== undefined) return false;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value });
        return true;
      }
      values.push(value);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ done: true, value: undefined as T });
      }
    },
    fail(err) {
      if (failure !== undefined) return;
      failure = err;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(err);
      }
    },
    async next() {
      if (failure !== undefined) throw failure;
      const value = values.shift();
      if (value !== undefined) return { done: false, value };
      if (closed) return { done: true, value: undefined as T };
      return new Promise<IteratorResult<T>>((resolve, reject) =>
        waiters.push({ resolve, reject }),
      );
    },
    async return() {
      iterator.close();
      return { done: true, value: undefined as T };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

function makeUserMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
    priority: "now",
  };
}

function messageContent(message: Record<string, unknown>): unknown[] {
  const nested = asRecord(message.message);
  const content = nested?.content ?? message.content;
  if (Array.isArray(content)) return content;
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  return value === null ? null : asString(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function firstString(value: unknown[] | undefined): string | undefined {
  return value?.find((item): item is string => typeof item === "string");
}

function permissionDenialsToStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    const record = asRecord(item);
    const toolName = asString(record?.tool_name) ?? "tool";
    const toolUseId = asString(record?.tool_use_id);
    return toolUseId ? `${toolName}:${toolUseId}` : toolName;
  });
}

function epochNumberToIso(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const millis = value > 1_000_000_000_000 ? value : value * 1_000;
  return new Date(millis).toISOString();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timeout);
      done();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
