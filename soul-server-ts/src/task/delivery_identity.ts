import { createHash } from "node:crypto";
export { hashDeliveryPayload } from "@soulstream/wire-schema/delivery";

import type { DeliveryIntent } from "./delivery_contract.js";

export interface DeterministicDeliveryIdentity {
  deliveryId: string;
  completionId: string;
  relationKey: string;
}

export function buildDeterministicDeliveryIdentity(params: {
  /** Routing target is deliberately not part of the immutable delivery identity. */
  targetSessionId: string;
  relationKey: string;
  intent: DeliveryIntent;
}): DeterministicDeliveryIdentity {
  const completionId = `completion:${hashHex(params.relationKey)}`;
  const deliverySeed = [
    params.intent,
    params.relationKey,
  ].join("\u0000");
  return {
    deliveryId: uuidFromHash(hashHex(deliverySeed)),
    completionId,
    relationKey: params.relationKey,
  };
}

/**
 * A durable delivery owns one stable Claude SDK input UUID across worker
 * restarts. The UUID is deliberately derived instead of reusing delivery_id
 * verbatim because external callers may supply non-UUID delivery identities.
 */
export function buildDeliveryInputUuid(deliveryId: string): string {
  return uuidFromHash(hashHex(`claude_input\u0000${deliveryId}`));
}

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuidFromHash(hex: string): string {
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const normalized = bytes.toString("hex");
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ].join("-");
}
