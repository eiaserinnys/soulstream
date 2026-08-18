import type { AddInterventionResult } from "./task_intervention_route.js";

export type CompletionDeliveryVerdict =
  | {
      kind: "accepted";
      disposition: "delivered" | "queued" | "auto_resume" | "consumed";
    }
  | { kind: "settled"; disposition: "superseded" }
  | { kind: "unknown"; reason: string }
  | { kind: "failed"; reason: string };

export function classifyCompletionDeliveryResult(
  result: AddInterventionResult,
): CompletionDeliveryVerdict {
  if ("queued" in result) {
    return { kind: "accepted", disposition: "queued" };
  }
  if ("delivered" in result && result.delivered === true) {
    return { kind: "accepted", disposition: "delivered" };
  }
  if ("autoResumed" in result) {
    return { kind: "accepted", disposition: "auto_resume" };
  }
  if ("delivered" in result && result.delivered === null) {
    return { kind: "unknown", reason: result.reason };
  }
  if ("suppressed" in result) {
    return classifySuppressedReason(result.reason);
  }
  return { kind: "failed", reason: result.reason };
}

export function classifyCompletionDeliveryAck(body: unknown): CompletionDeliveryVerdict {
  if (!isRecord(body)) return { kind: "unknown", reason: "verdict_missing" };
  const outcome = stringValue(body.outcome);
  if (outcome === "delivered") {
    return body.delivered === true
      ? { kind: "accepted", disposition: "delivered" }
      : { kind: "unknown", reason: "delivered_evidence_incomplete" };
  }
  if (outcome === "queued") {
    return body.delivered === false
      && typeof body.queuePosition === "number"
      && body.consumeWhen === "next_turn"
      ? { kind: "accepted", disposition: "queued" }
      : { kind: "unknown", reason: "queued_evidence_incomplete" };
  }
  if (outcome === "auto_resumed") {
    return body.delivered === true
      ? { kind: "accepted", disposition: "auto_resume" }
      : { kind: "unknown", reason: "auto_resume_evidence_incomplete" };
  }
  if (outcome === "suppressed") {
    const reason = stringValue(body.reason);
    return reason
      ? classifySuppressedReason(reason)
      : { kind: "unknown", reason: "suppression_reason_missing" };
  }
  if (outcome === "deferred") {
    return { kind: "failed", reason: stringValue(body.reason) ?? "delivery_deferred" };
  }
  if (outcome === "unknown" || body.delivered === null) {
    return { kind: "unknown", reason: stringValue(body.reason) ?? "verdict_unknown" };
  }
  return { kind: "unknown", reason: "verdict_missing" };
}

function classifySuppressedReason(reason: string): CompletionDeliveryVerdict {
  const state = /^delivery_(queued|delivered|consumed|superseded|uncertain)(?:_before_dispatch)?$/
    .exec(reason)?.[1];
  if (state === "queued" || state === "delivered") {
    return { kind: "accepted", disposition: state };
  }
  if (state === "consumed") {
    return { kind: "accepted", disposition: "consumed" };
  }
  if (state === "superseded") {
    return { kind: "settled", disposition: state };
  }
  if (state === "uncertain") {
    return { kind: "unknown", reason: "legacy_delivery_uncertain" };
  }
  if (
    reason === "delivery_identity_mismatch"
    || reason === "identity_conflict_uncertain"
  ) {
    return { kind: "unknown", reason };
  }
  return { kind: "failed", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
