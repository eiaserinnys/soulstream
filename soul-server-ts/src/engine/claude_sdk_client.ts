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
/**
 * Result 도착 후 SDK가 발행하는 `prompt_suggestion` 메시지를 받기 위한 short drain 시간.
 *
 * Python `soul-server/src/soul_server/claude/receive_loop.py:33 PROMPT_SUGGESTION_DRAIN_TIMEOUT`
 * 2초 정본 정합. SDK 0.2.x 타입 정의 (sdk.d.ts) 명시:
 * "prompt_suggestion arrives after the result message. Consumers must keep iterating the
 *  stream after result to receive it."
 *
 * drain phase는 *prompt_suggestion 전용* — 그 외 메시지는 logger.warn 후 무시 (Python
 * receive_loop.py:180-188 narrowing 정책 정합).
 */
const DEFAULT_POST_RESULT_DRAIN_MS = 2_000;
const INPUT_REQUEST_TIMEOUT = Symbol("input_request_timeout");
const INPUT_REQUEST_ABORTED = Symbol("input_request_aborted");
const DRAIN_TIMEOUT = Symbol("post_result_drain_timeout");

export type ClaudeSdkQueryParams = {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeSdkOptions;
};

export type ClaudeSdkQueryFn = (params: ClaudeSdkQueryParams) => ClaudeSdkQuery;

export interface ClaudeSdkClientConfig {
  query?: ClaudeSdkQueryFn;
  inputRequestTimeoutMs?: number;
  interventionPollIntervalMs?: number;
  /**
   * Result 메시지 도착 후 prompt_suggestion 1메시지를 기다리는 best-effort drain timeout.
   * 기본 2초 — Python `PROMPT_SUGGESTION_DRAIN_TIMEOUT` 정합. 테스트에서 가속용으로만 override.
   */
  postResultDrainMs?: number;
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
  private readonly postResultDrainMs: number;
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
    this.postResultDrainMs =
      config.postResultDrainMs ?? DEFAULT_POST_RESULT_DRAIN_MS;
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
      const queryIter = query[Symbol.asyncIterator]();
      for (;;) {
        const next = await queryIter.next();
        if (next.done) break;
        const message = next.value;

        let shouldStop = false;
        for (const event of this.mapSdkMessage(message)) {
          output.push(event);
          if (event.type === "complete" || (event.type === "error" && event.fatal !== false)) {
            shouldStop = true;
          }
        }
        if (shouldStop) {
          // Result/complete (또는 fatal error) 도착 — post-result drain phase로 진입.
          // Python `receive_loop._drain_after_result` (L126-188) 정합:
          //   - prompt_suggestion 1메시지를 best-effort로 기다림 (default 2초)
          //   - 그 외 메시지(StreamEvent · stray assistant 등)는 narrowing → logger.warn 후 무시
          //   - timeout / EOS / 에러 모두 조용히 종료 (drain은 부가 기능, §8 실패 격리)
          await this.drainAfterResult(queryIter, output);
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

  /**
   * Result 이후 prompt_suggestion 1메시지를 받기 위한 short drain.
   *
   * Python `receive_loop._drain_after_result` 정본 정합:
   *   - timeout 만료 / EOS / 비 prompt_suggestion 메시지 → 조용히 종료 (return)
   *   - PromptSuggestionMessage이면 mapPromptSuggestion 결과를 output에 push
   *
   * `iter.next()`를 *호출만 하고 race*하는 패턴 — Python의 `extra_task = asyncio.create_task(aiter.__anext__())` 정합.
   * timeout이 먼저 만료되어도 in-flight next()를 강제 cancel할 수 없으므로 fire-and-forget으로 두고
   * 함수가 즉시 반환. 다음 호출자(`query.close()`)가 stream 종료 신호를 주면 in-flight next()도 함께 정리됨.
   */
  private async drainAfterResult(
    queryIter: AsyncIterator<SDKMessage>,
    output: EventQueue<ClaudeClientEvent>,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof DRAIN_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(DRAIN_TIMEOUT), this.postResultDrainMs);
    });

    const nextPromise = queryIter.next().then(
      (res) => res,
      (err) => ({ done: true as const, value: undefined as unknown as SDKMessage, _error: err }),
    );

    try {
      const settled = await Promise.race([nextPromise, timeoutPromise]);
      if (settled === DRAIN_TIMEOUT) {
        this.logger.debug?.({ ms: this.postResultDrainMs }, "post-result drain timed out");
        return;
      }
      if (settled.done) {
        return;
      }
      const msg = asRecord(settled.value);
      if (msg && msg.type === "prompt_suggestion") {
        for (const event of this.mapPromptSuggestion(msg)) {
          output.push(event);
        }
        return;
      }
      // 비 prompt_suggestion 메시지는 무시 + warn (Python narrowing 정책 정합)
      this.logger.warn?.(
        { messageType: msg?.type ?? "unknown" },
        "post-result drain received unexpected message type — ignoring",
      );
    } catch (err) {
      this.logger.debug?.({ err }, "post-result drain errored — ignoring");
    } finally {
      if (timer) clearTimeout(timer);
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

/**
 * rate_limit_info.resetsAt 값을 SSE wire용 ISO 문자열로 정규화.
 *
 * 수용 입력:
 *   - epoch seconds (≤ 1e12): Date 객체로 변환 후 ISO
 *   - epoch milliseconds (> 1e12): Date 객체로 변환 후 ISO
 *   - ISO 문자열: 그대로 passthrough
 *   - undefined / 그 외: undefined
 */
function coerceResetsAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return epochNumberToIso(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
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
