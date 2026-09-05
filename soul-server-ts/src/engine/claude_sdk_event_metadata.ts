import { createHash } from "node:crypto";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import {
  attachClaudeResultReceiptMetadata,
  readClaudeResultReceiptMetadata,
} from "./claude_result_receipt_metadata.js";
import {
  attachClaudeToolResultReceiptMetadata,
  readClaudeToolResultReceiptMetadata,
} from "./claude_tool_result_receipt_metadata.js";
import {
  attachClaudeSdkSessionMetadata,
  readClaudeSdkSessionMetadata,
} from "./claude_sdk_session_metadata.js";
import { asRecord, asString } from "./claude_sdk_helpers.js";

export function attachClaudeToolResultEnvelope(
  event: ClaudeClientEvent,
  message: Record<string, unknown>,
): void {
  const envelope = asRecord(message.tool_use_result);
  if (envelope) attachClaudeToolResultReceiptMetadata(event, { envelope });
}

export function attachClaudeResultInputReceipt(
  events: ClaudeClientEvent[],
  message: Record<string, unknown>,
): void {
  const inputUuid = asString(message.user_message_uuid);
  const resultEvent = events.find((event) => event.type === "result");
  if (inputUuid && resultEvent) {
    attachClaudeResultReceiptMetadata(resultEvent, { inputUuid });
  }
}

export function attachClaudeRuntimeSdkSession(
  events: ClaudeClientEvent[],
  sessionId: string | undefined,
): ClaudeClientEvent[] {
  if (!sessionId) return events;
  for (const event of events) {
    if (runtimeTaskId(event)) {
      attachClaudeSdkSessionMetadata(event, { sessionId });
    }
  }
  return events;
}

export function copyClaudeSdkEventMetadata(
  source: ClaudeClientEvent,
  target: ClaudeClientEvent,
  fallbackSessionId: string | undefined,
): ClaudeClientEvent {
  const resultReceipt = readClaudeResultReceiptMetadata(source);
  if (resultReceipt) attachClaudeResultReceiptMetadata(target, resultReceipt);
  const toolResultReceipt = readClaudeToolResultReceiptMetadata(source);
  if (toolResultReceipt) {
    attachClaudeToolResultReceiptMetadata(target, toolResultReceipt);
  }
  const sessionId = readClaudeSdkSessionMetadata(source)?.sessionId ??
    (runtimeTaskId(source) ? fallbackSessionId : undefined);
  if (sessionId) attachClaudeSdkSessionMetadata(target, { sessionId });
  return target;
}

export function runtimeTaskId(event: ClaudeClientEvent): string | undefined {
  switch (event.type) {
    case "claude_runtime_task_started":
    case "claude_runtime_task_created":
    case "claude_runtime_task_updated":
    case "claude_runtime_task_progress":
    case "claude_runtime_task_completed":
    case "claude_runtime_task_notification":
      return event.taskId;
    default:
      return undefined;
  }
}

export function fallbackClaudeSdkMessageIdentity(
  message: Record<string, unknown>,
): string {
  const nestedMessage = asRecord(message.message);
  const role = asString(nestedMessage?.role) ?? asString(message.role) ??
    asString(message.type) ?? "message";
  const content = nestedMessage?.content ?? message.content ?? message;
  const hash = createHash("sha256")
    .update(canonicalJson({ role, content }))
    .digest("hex")
    .slice(0, 32);
  return `content:${role}:${hash}`;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
