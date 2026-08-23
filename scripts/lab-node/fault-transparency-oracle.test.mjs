import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTransparencyObservation,
  transparencyDifferences,
} from "./fault-transparency-oracle.mjs";

test("transparent observations ignore delay and volatile response identity only", () => {
  const baseline = buildTransparencyObservation(observationInput({
    callerOutcome: {
      status: "fulfilled",
      value: {
        delivered: false,
        reason: "queued_for_next_turn",
        consumeWhen: "next_turn",
        delivery_id: "baseline-delivery",
      },
    },
  }));
  const restarted = buildTransparencyObservation(observationInput({
    callerOutcome: {
      status: "fulfilled",
      value: {
        delivered: false,
        reason: "queued_for_next_turn",
        consumeWhen: "next_turn",
        delivery_id: "restart-delivery",
      },
    },
    shiftedByMs: 90_000,
  }));

  assert.deepEqual(transparencyDifferences(baseline, restarted), []);
});

test("caller-visible restart errors and changed queue signals fail transparency", () => {
  const baseline = buildTransparencyObservation(observationInput());
  const rejected = buildTransparencyObservation(observationInput({
    callerOutcome: {
      status: "rejected",
      reason: { name: "Error", message: "HTTP 503: restart in progress" },
    },
  }));
  const changedReason = buildTransparencyObservation(observationInput({
    callerOutcome: {
      status: "fulfilled",
      value: {
        delivered: false,
        reason: "restart_queue",
        consumeWhen: "next_turn",
      },
    },
  }));

  assert.deepEqual(transparencyDifferences(baseline, rejected).map(({ field }) => field), [
    "callerOutcome",
  ]);
  assert.deepEqual(transparencyDifferences(baseline, changedReason).map(({ field }) => field), [
    "callerOutcome",
  ]);
});

test("tool loss, duplicate replies, and agent-visible errors fail transparency", () => {
  const baseline = buildTransparencyObservation(observationInput());
  const brokenInput = observationInput();
  brokenInput.timeline.messages = brokenInput.timeline.messages.filter(
    ({ event_type }) => event_type !== "tool_result",
  );
  brokenInput.timeline.messages.push(
    { event_id: 7, event_type: "assistant_message", payload: { content: "CONTEXT_OK" } },
    { event_id: 8, event_type: "assistant_error", payload: { message: "runner reset" } },
  );
  const broken = buildTransparencyObservation(brokenInput);

  assert.deepEqual(transparencyDifferences(baseline, broken).map(({ field }) => field), [
    "eventSequence",
    "counts",
    "visibleErrors",
    "visibleSignals",
  ]);
});

function observationInput(options = {}) {
  const shiftedByMs = options.shiftedByMs ?? 0;
  return {
    terminalStatus: "completed",
    initialPrompt: "INITIAL_PROMPT",
    interventionText: "INTERVENTION_PROMPT",
    initialMarker: "INITIAL_OK",
    contextMarker: "CONTEXT_OK",
    callerOutcome: options.callerOutcome ?? {
      status: "fulfilled",
      value: {
        delivered: false,
        reason: "queued_for_next_turn",
        consumeWhen: "next_turn",
      },
    },
    timeline: {
      messages: [
        timelineEvent(1, "user_message", { text: "INITIAL_PROMPT" }, shiftedByMs),
        timelineEvent(2, "tool_start", { name: "Bash" }, shiftedByMs),
        timelineEvent(3, "intervention_sent", { text: "INTERVENTION_PROMPT" }, shiftedByMs),
        timelineEvent(4, "tool_result", { is_error: false, content: "" }, shiftedByMs),
        timelineEvent(5, "assistant_message", { content: "INITIAL_OK" }, shiftedByMs),
        timelineEvent(6, "assistant_message", { content: "CONTEXT_OK" }, shiftedByMs),
      ],
    },
  };
}

function timelineEvent(eventId, eventType, payload, shiftedByMs) {
  return {
    event_id: eventId,
    event_type: eventType,
    payload,
    created_at: new Date(shiftedByMs + eventId * 1_000).toISOString(),
  };
}
