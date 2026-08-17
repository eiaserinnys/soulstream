import { describe, expect, it } from "vitest";

import {
  classifyCompletionDeliveryAck,
  classifyCompletionDeliveryResult,
} from "../../src/task/completion_delivery_verdict.js";

describe("completion delivery verdict", () => {
  it.each([
    [{ delivered: true }, { kind: "accepted", disposition: "delivered" }],
    [
      {
        delivered: false,
        queued: true,
        queuePosition: 2,
        consumeWhen: "next_turn",
        reason: "queue_only_policy",
      },
      { kind: "accepted", disposition: "queued" },
    ],
    [{ autoResumed: true }, { kind: "accepted", disposition: "auto_resume" }],
    [
      { suppressed: true, deliveryId: "d1", reason: "delivery_consumed" },
      { kind: "accepted", disposition: "consumed" },
    ],
    [
      { suppressed: true, deliveryId: "d1", reason: "delivery_superseded" },
      { kind: "settled", disposition: "superseded" },
    ],
    [
      { suppressed: true, deliveryId: "d1", reason: "delivery_uncertain" },
      { kind: "settled", disposition: "uncertain" },
    ],
    [
      { delivered: null, reason: "verdict_unknown", consumeWhen: null },
      { kind: "unknown", reason: "verdict_unknown" },
    ],
    [
      {
        delivered: false,
        deferred: true,
        retryWhen: "engine_available",
        reason: "not_accepting_input",
      },
      { kind: "failed", reason: "not_accepting_input" },
    ],
    [
      {
        suppressed: true,
        deliveryId: "d1",
        reason: "delivery_claimed_before_dispatch",
      },
      { kind: "failed", reason: "delivery_claimed_before_dispatch" },
    ],
    [
      { suppressed: true, deliveryId: "d1", reason: "delivery_identity_mismatch" },
      { kind: "unknown", reason: "delivery_identity_mismatch" },
    ],
  ] as const)("classifies local result %#", (result, expected) => {
    expect(classifyCompletionDeliveryResult(result)).toEqual(expected);
  });

  it.each([
    [
      { outcome: "delivered", delivered: true },
      { kind: "accepted", disposition: "delivered" },
    ],
    [
      {
        outcome: "queued",
        delivered: false,
        queuePosition: 3,
        consumeWhen: "next_turn",
        reason: "queue_only_policy",
      },
      { kind: "accepted", disposition: "queued" },
    ],
    [
      { outcome: "auto_resumed", delivered: true },
      { kind: "accepted", disposition: "auto_resume" },
    ],
    [
      {
        outcome: "suppressed",
        delivered: false,
        reason: "delivery_consumed_before_dispatch",
      },
      { kind: "accepted", disposition: "consumed" },
    ],
    [
      {
        outcome: "suppressed",
        delivered: false,
        reason: "delivery_superseded_before_dispatch",
      },
      { kind: "settled", disposition: "superseded" },
    ],
    [
      { outcome: "unknown", delivered: null, reason: "verdict_unknown" },
      { kind: "unknown", reason: "verdict_unknown" },
    ],
    [
      {
        outcome: "deferred",
        delivered: false,
        reason: "terminal_only_policy",
      },
      { kind: "failed", reason: "terminal_only_policy" },
    ],
    [
      {
        outcome: "suppressed",
        delivered: false,
        reason: "delivery_dispatching_before_dispatch",
      },
      { kind: "failed", reason: "delivery_dispatching_before_dispatch" },
    ],
    [
      { delivered: false },
      { kind: "unknown", reason: "verdict_missing" },
    ],
    [
      { outcome: "queued", delivered: false, queuePosition: 3 },
      { kind: "unknown", reason: "queued_evidence_incomplete" },
    ],
    [
      { delivered: true },
      { kind: "accepted", disposition: "delivered" },
    ],
  ] as const)("classifies cross-node ack %#", (ack, expected) => {
    expect(classifyCompletionDeliveryAck(ack)).toEqual(expected);
  });
});
