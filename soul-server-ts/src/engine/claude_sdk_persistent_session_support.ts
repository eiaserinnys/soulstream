import { createHash } from "node:crypto";

import type {
  Query as ClaudeSdkQuery,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import type { EventQueue } from "./claude_sdk_event_queue.js";
import { messageContent } from "./claude_sdk_event_mapper_helpers.js";
import { asRecord, asString } from "./claude_sdk_helpers.js";
import type { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import type { RateLimitTerminationState } from
  "./claude_sdk_rate_limit_stop_failure.js";
import type { ClaudeForegroundPhase } from "./claude_session_runtime.js";

export type ClaudeDetachedEventSink = (event: ClaudeClientEvent) => Promise<void>;
export type ClaudeRuntimeEventSink = (
  event: ClaudeClientEvent,
) => Promise<boolean | void>;

export interface ClaudeSdkPersistentSessionConfig {
  createQuery(input: AsyncIterable<SDKUserMessage>): ClaudeSdkQuery;
  eventMapper: ClaudeSdkEventMapper;
  hookOutput: EventQueue<ClaudeClientEvent>;
  detachedEventSink: ClaudeDetachedEventSink;
  runtimeEventSink?: ClaudeRuntimeEventSink;
  logger: Logger;
  postResultDrainMs: number;
  turnInactivityTimeoutMs: number;
  runtimeFollowupNoOutputTimeoutMs: number;
  onClosed?(): void;
}

export type ActiveForeground = {
  uuid: string;
  /** Owner captured immediately before a native intervention interrupts it. */
  interruptedOwnerUuid?: string;
  output: EventQueue<ClaudeClientEvent>;
  interruptResultTimer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
  origin: { kind: string; id: string };
  rateLimitTerminationState: RateLimitTerminationState;
};

export function describeResultProvenance(
  message: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resultUuid: asString(message.uuid),
    subtype: asString(message.subtype),
    isError: message.is_error === true,
    terminalReason: asString(message.terminal_reason) ?? null,
    originKind: asString(asRecord(message.origin)?.kind) ?? null,
    numTurns: message.num_turns ?? null,
  };
}

export function provableTurnResultOwner(
  phase: ClaudeForegroundPhase,
  active: ActiveForeground | null,
  message: Record<string, unknown>,
  logger: Logger,
): string | null {
  // Bare Results also terminate SDK-owned notification turns. Only the abort
  // Result of our sole interrupting foreground can inherit local ownership.
  if (phase !== "interrupting" || !active) return null;
  if (asString(asRecord(message.origin)?.kind) === "task-notification") return null;
  const ownerUuid = active.interruptedOwnerUuid ?? active.uuid;
  logger.info(
    {
      activeForegroundUuid: active.uuid,
      interruptedOwnerUuid: ownerUuid,
      resultUuid: asString(message.uuid),
    },
    "Correlating Claude Result without user_message_uuid to the interrupted turn",
  );
  return ownerUuid;
}

export function isExpectedInterruptDiagnostic(event: ClaudeClientEvent): boolean {
  return event.type === "error"
    && event.fatal === false
    && event.errorCode === "error_during_execution";
}

export function isTurnStartingUserInput(message: Record<string, unknown>): boolean {
  if (message.isSynthetic === true) return false;
  const content = messageContent(message);
  return content.length === 0
    || content.some((block) => asString(asRecord(block)?.type) !== "tool_result");
}

export function hashSdkUserMessage(message: SDKUserMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

export function turnInactivityError(timeoutMs: number): ClaudeClientEvent {
  return {
    type: "error",
    fatal: true,
    errorCode: "claude_persistent_turn_timeout",
    message: `Claude foreground turn was inactive for ${timeoutMs}ms and was interrupted.`,
  };
}
