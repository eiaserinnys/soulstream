import { createHash } from "node:crypto";

import type { DeliveryIntent } from "./delivery_contract.js";

export interface DeterministicDeliveryIdentity {
  deliveryId: string;
  completionId: string;
  relationKey: string;
}

export function buildDeterministicDeliveryIdentity(params: {
  targetSessionId: string;
  relationKey: string;
  intent: DeliveryIntent;
}): DeterministicDeliveryIdentity {
  const completionId = `completion:${hashHex(params.relationKey)}`;
  const deliverySeed = [
    params.targetSessionId,
    params.intent,
    params.relationKey,
  ].join("\u0000");
  return {
    deliveryId: uuidFromHash(hashHex(deliverySeed)),
    completionId,
    relationKey: params.relationKey,
  };
}

export function hashDeliveryPayload(value: Record<string, unknown>): string {
  return hashHex(JSON.stringify(value));
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
