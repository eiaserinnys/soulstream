import type { SSEEventPayload } from "./protocol.js";

export interface ClaudeBackgroundDeliveryMetadata {
  deliveryId: string;
  completionId: string;
  relationKey: string;
  producerTerminalRevision: string;
  deliveryCreatedAt: string;
}

const DELIVERY_METADATA = Symbol("claude-background-delivery");

export function attachClaudeBackgroundDeliveryMetadata(
  target: object,
  metadata: ClaudeBackgroundDeliveryMetadata,
): void {
  Object.defineProperty(target, DELIVERY_METADATA, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
}

export function readClaudeBackgroundDeliveryMetadata(
  target: object,
): ClaudeBackgroundDeliveryMetadata | undefined {
  return (target as Record<symbol, ClaudeBackgroundDeliveryMetadata | undefined>)[
    DELIVERY_METADATA
  ];
}

export function copyClaudeBackgroundDeliveryMetadata(
  event: object,
  payloads: SSEEventPayload[],
): SSEEventPayload[] {
  const metadata = readClaudeBackgroundDeliveryMetadata(event);
  if (!metadata) return payloads;
  for (const payload of payloads) {
    attachClaudeBackgroundDeliveryMetadata(payload, metadata);
  }
  return payloads;
}
