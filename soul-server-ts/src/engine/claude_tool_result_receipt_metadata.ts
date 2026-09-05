import type { SSEEventPayload } from "./protocol.js";

export interface ClaudeToolResultReceiptMetadata {
  envelope: Record<string, unknown>;
}

const TOOL_RESULT_RECEIPT_METADATA = Symbol("claude-tool-result-receipt");

export function attachClaudeToolResultReceiptMetadata(
  target: object,
  metadata: ClaudeToolResultReceiptMetadata,
): void {
  Object.defineProperty(target, TOOL_RESULT_RECEIPT_METADATA, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
}

export function readClaudeToolResultReceiptMetadata(
  target: object,
): ClaudeToolResultReceiptMetadata | undefined {
  return (target as Record<symbol, ClaudeToolResultReceiptMetadata | undefined>)[
    TOOL_RESULT_RECEIPT_METADATA
  ];
}

export function copyClaudeToolResultReceiptMetadata(
  event: object,
  payloads: SSEEventPayload[],
): SSEEventPayload[] {
  const metadata = readClaudeToolResultReceiptMetadata(event);
  if (!metadata) return payloads;
  for (const payload of payloads) {
    if (payload.type === "tool_result") {
      attachClaudeToolResultReceiptMetadata(payload, metadata);
    }
  }
  return payloads;
}
