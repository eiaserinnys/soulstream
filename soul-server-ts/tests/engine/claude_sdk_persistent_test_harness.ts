import type {
  Query as ClaudeSdkQuery,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { expect, vi } from "vitest";

import type {
  ClaudeSdkQueryFn,
  ClaudeSdkQueryParams,
} from "../../src/engine/claude_sdk_client.js";
import { createEventQueue } from "../../src/engine/claude_sdk_event_queue.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";

export function makeHarness(
  options: { receipt?: SDKControlInterruptResponse } = {},
) {
  const captured: ClaudeSdkQueryParams[] = [];
  let input: AsyncIterable<SDKUserMessage> | null = null;
  let activeOutput = createEventQueue<SDKMessage>();
  const interrupt = vi.fn(async () => options.receipt);
  const close = vi.fn();
  const queryFn: ClaudeSdkQueryFn = (params) => {
    captured.push(params);
    input = params.prompt as AsyncIterable<SDKUserMessage>;
    const output = createEventQueue<SDKMessage>();
    activeOutput = output;
    return {
      interrupt,
      close: () => {
        close();
        output.close();
      },
      backgroundTasks: vi.fn(async () => false),
      stopTask: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: () => output,
    } as unknown as ClaudeSdkQuery;
  };
  return {
    captured,
    close,
    detached: vi.fn(async (_event: ClaudeClientEvent) => undefined),
    fail: (error: Error) => activeOutput.fail(error),
    interrupt,
    push: (message: SDKMessage) => activeOutput.push(message),
    queryFn,
    async nextInput(): Promise<SDKUserMessage> {
      await vi.waitFor(() => expect(input).not.toBeNull());
      const next = await input![Symbol.asyncIterator]().next();
      if (next.done) throw new Error("Persistent input queue closed unexpectedly");
      return next.value;
    },
  };
}

export function runOptions(prompt: string) {
  return {
    agentSessionId: "agent-session",
    prompt,
    workspaceDir: "/tmp/claude-persistent",
  };
}

export function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

export function sdkInit(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    uuid: `init-${sessionId}`,
    session_id: sessionId,
    cwd: "/tmp/claude-persistent",
    tools: [],
    mcp_servers: [],
    model: "claude",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "test",
    output_style: "default",
    agents: [],
    skills: [],
    plugins: [],
  } as unknown as SDKMessage;
}

export function sdkResult(
  sessionId: string,
  userMessageUuid: string | undefined,
  result: string,
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    uuid: `result-${result}`,
    session_id: sessionId,
    user_message_uuid: userMessageUuid,
    is_error: false,
    result,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: {},
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}

export function sdkInterruptedResult(
  sessionId: string,
  userMessageUuid: string | undefined,
): SDKMessage {
  return {
    ...sdkResult(sessionId, userMessageUuid, ""),
    subtype: "error_during_execution",
    is_error: true,
    errors: [
      "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null (aborted_streaming)",
    ],
    stop_reason: null,
  } as unknown as SDKMessage;
}

/**
 * Terminal Result of a turn the session never enqueued.
 *
 * SDK 0.3.218 runs its own notification turn when a background task finishes
 * and returns that turn's Result with no `user_message_uuid` and an explicit
 * `task-notification` origin.
 */
export function sdkTaskNotificationResult(sessionId: string): SDKMessage {
  const message = sdkResult(sessionId, undefined, "background task finished") as
    unknown as Record<string, unknown>;
  delete message.user_message_uuid;
  return {
    ...message,
    uuid: "result-task-notification",
    origin: { kind: "task-notification" },
    num_turns: 1,
  } as unknown as SDKMessage;
}

export async function collect(
  iterable: AsyncIterable<ClaudeClientEvent>,
): Promise<ClaudeClientEvent[]> {
  const events: ClaudeClientEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

export async function collectSse(
  iterable: AsyncIterable<SSEEventPayload>,
): Promise<SSEEventPayload[]> {
  return await collectRemaining(iterable[Symbol.asyncIterator]());
}

export async function collectRemaining<T>(
  iterator: AsyncIterator<T>,
): Promise<T[]> {
  const values: T[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return values;
    values.push(next.value);
  }
}
