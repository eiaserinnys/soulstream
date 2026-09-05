import type { SSEEventPayload } from "./protocol.js";

export interface ClaudeResultReceiptMetadata {
  inputUuid: string;
}

const RESULT_RECEIPT_METADATA = Symbol("claude-result-receipt");

export function attachClaudeResultReceiptMetadata(
  target: object,
  metadata: ClaudeResultReceiptMetadata,
): void {
  Object.defineProperty(target, RESULT_RECEIPT_METADATA, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
}

export function readClaudeResultReceiptMetadata(
  target: object,
): ClaudeResultReceiptMetadata | undefined {
  return (target as Record<symbol, ClaudeResultReceiptMetadata | undefined>)[
    RESULT_RECEIPT_METADATA
  ];
}

export function copyClaudeResultReceiptMetadata(
  event: object,
  payloads: SSEEventPayload[],
): SSEEventPayload[] {
  const metadata = readClaudeResultReceiptMetadata(event);
  if (!metadata) return payloads;
  for (const payload of payloads) {
    if (payload.type === "result") attachClaudeResultReceiptMetadata(payload, metadata);
  }
  return payloads;
}
