import { randomUUID } from "node:crypto";

import type {
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type {
  ClaudeAccountRateLimitSwitchRequest,
  ClaudeRunOptions,
} from "./claude_adapter.js";
import type { ClaudeSdkQueryFn } from "./claude_sdk_client.js";
import type { ClaudeClientEvent } from "./claude_client_event.js";
import { ClaudePostResultDrain } from "./claude_sdk_drain.js";
import { type EventQueue, createEventQueue } from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { pumpLegacyClaudeQuery } from "./claude_sdk_legacy_pump.js";
import { buildClaudeSdkOptions } from "./claude_sdk_options.js";
import { ClaudeSdkRateLimitSwitchGate } from "./claude_sdk_rate_limit_switch_gate.js";
import { ClaudeSdkUsageCarry } from "./claude_sdk_usage_carry.js";
import type { ClaudeRuntimeCloseReason } from "./claude_session_runtime.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";
import { ClaudeSdkToolPermissionController } from "./claude_sdk_tool_permissions.js";

export interface ClaudeSdkOneShotAttemptContext {
  queryFn: ClaudeSdkQueryFn;
  logger: Logger;
  resolveClaudeExecutablePath(): string | undefined;
  eventMapper: ClaudeSdkEventMapper;
  runtimeState: ClaudeRuntimeState;
  toolPermissionController: ClaudeSdkToolPermissionController;
  postResultDrainer: ClaudePostResultDrain;
  setActiveInput(input: EventQueue<SDKUserMessage> | null): void;
  setActiveQuery(query: ClaudeSdkQuery | null): void;
  clearActiveQuery(query: ClaudeSdkQuery): void;
  setActiveQueryPump(pump: Promise<void> | null): void;
  clearActiveQueryPump(pump: Promise<void>): void;
  isQueryActive(query: ClaudeSdkQuery): boolean;
  closeActiveInput(input: EventQueue<SDKUserMessage>): void;
  trackChildExit(closed: Promise<void>): void;
  waitForChildExit(): Promise<void>;
  normalizeExecutionError(error: unknown, executablePath?: string): Error;
}

export async function* runClaudeSdkOneShotAttempt(
  context: ClaudeSdkOneShotAttemptContext,
  options: ClaudeRunOptions,
  signal: AbortSignal,
  usageCarry?: ClaudeSdkUsageCarry,
): AsyncGenerator<ClaudeClientEvent, ClaudeAccountRateLimitSwitchRequest | null, void> {
  const output = createEventQueue<ClaudeClientEvent>();
  const input = createEventQueue<SDKUserMessage>();
  const inputUuid = options.inputUuid ?? (options.onAccountRateLimit ? randomUUID() : undefined);
  let inputConsumed = false;
  input.push(makeUserMessage(
    options.prompt,
    options.imageAttachmentPaths,
    inputUuid ? { uuid: inputUuid } : undefined,
  ));
  const sdkInput = (async function* (): AsyncGenerator<SDKUserMessage> {
    for await (const message of input) {
      inputConsumed = true;
      yield message;
    }
  })();

  const abortController = new AbortController();
  const abortSdk = () => abortController.abort(signal.reason);
  if (signal.aborted) {
    abortSdk();
  } else {
    signal.addEventListener("abort", abortSdk, { once: true });
  }

  const queryOptions = buildClaudeSdkOptions({
    options,
    abortController,
    output,
    logger: context.logger,
    resolveClaudeExecutablePath: context.resolveClaudeExecutablePath,
    eventMapper: context.eventMapper,
    runtimeState: context.runtimeState,
    toolPermissionController: context.toolPermissionController,
    ...(options.trackChildExit
      ? { onChildProcessClosed: (closed) => context.trackChildExit(closed) }
      : {}),
  });
  let query: ClaudeSdkQuery;
  context.setActiveInput(input);
  try {
    query = context.queryFn({ prompt: sdkInput, options: queryOptions });
  } catch (err) {
    context.closeActiveInput(input);
    signal.removeEventListener("abort", abortSdk);
    throw context.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
  }
  context.setActiveQuery(query);
  const pump = pumpLegacyClaudeQuery({
    query,
    output,
    signal: abortController.signal,
    input,
    eventMapper: context.eventMapper,
    postResultDrainer: context.postResultDrainer,
    runtimeState: context.runtimeState,
    logger: context.logger,
    isQueryActive: context.isQueryActive,
    closeInput: context.closeActiveInput,
  });
  context.setActiveQueryPump(pump);

  const rateLimitGate = options.onAccountRateLimit
    ? new ClaudeSdkRateLimitSwitchGate()
    : null;
  let switchRequest: ClaudeAccountRateLimitSwitchRequest | null = null;
  let closeReason: ClaudeRuntimeCloseReason | undefined;
  let observedSessionId = options.resumeSessionId;
  let terminalBatch: ClaudeClientEvent[] | null = null;
  const takeOutput = (event: ClaudeClientEvent): ClaudeClientEvent[] => {
    if (!usageCarry) return [event];
    if (terminalBatch) {
      terminalBatch.push(event);
      if (event.type !== "complete") return [];
      const completed = usageCarry.applyTo(terminalBatch);
      terminalBatch = null;
      return completed;
    }
    if (event.type === "result") {
      terminalBatch = [event];
      return [];
    }
    return [event];
  };

  try {
    for await (const event of output) {
      if (event.type === "session") observedSessionId = event.sessionId;
      else if ("sessionId" in event && typeof event.sessionId === "string") {
        observedSessionId = event.sessionId;
      }
      if (switchRequest) {
        if (event.type === "result") terminalBatch = [event];
        else if (terminalBatch) {
          terminalBatch.push(event);
          if (event.type === "complete") {
            usageCarry?.absorb(terminalBatch);
            terminalBatch = null;
          }
        }
        continue;
      }
      if (rateLimitGate) {
        const observation = rateLimitGate.observe(event);
        if (observation.kind === "pending") continue;
        if (observation.kind === "switch") {
          usageCarry?.absorb(rateLimitGate.discard());
          if (terminalBatch) {
            usageCarry?.absorb(terminalBatch);
            terminalBatch = null;
          }
          switchRequest = {
            info: observation.info,
            ...(observedSessionId ? { sessionId: observedSessionId } : {}),
            inputUuid: inputUuid ?? randomUUID(),
            // The SDK writes consumed prompts immediately. Once pulled, transport delivery
            // is ambiguous because the SDK write may still be pending.
            inputDelivery: inputConsumed ? "ambiguous" : "not_sent",
          };
          closeReason = "account_switch";
          context.closeActiveInput(input);
          query.close();
          continue;
        }
      }
      for (const visible of takeOutput(event)) yield visible;
    }
    if (!switchRequest && rateLimitGate?.hasPendingSignal()) {
      for (const buffered of rateLimitGate.flush()) {
        for (const visible of takeOutput(buffered)) yield visible;
      }
    }
    if (terminalBatch) {
      if (switchRequest) {
        usageCarry?.absorb(terminalBatch);
      } else {
        for (const visible of usageCarry?.applyTo(terminalBatch) ?? terminalBatch) yield visible;
      }
      terminalBatch = null;
    }
    await pump;
    return switchRequest;
  } catch (err) {
    throw context.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
  } finally {
    signal.removeEventListener("abort", abortSdk);
    context.clearActiveQuery(query);
    context.closeActiveInput(input);
    context.toolPermissionController.abortPendingInputRequests();
    await pump.catch(() => undefined);
    context.clearActiveQueryPump(pump);
    if (options.trackChildExit) await context.waitForChildExit();
    await options.onAccountQueryClosed?.(closeReason);
  }
}
