import { createHash } from "node:crypto";

import type { DeliveryIntent } from "./delivery_contract.js";

export interface DeterministicDeliveryIdentity {
  deliveryId: string;
  completionId: string;
  relationKey: string;
}

export function buildDeterministicDeliveryIdentity(params: {
  /** Routing target is deliberately not identity: supervisors may be replaced. */
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

export function hashDeliveryPayload(value: Record<string, unknown>): string {
  return hashHex(JSON.stringify(canonicalize(value)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : canonicalize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
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
