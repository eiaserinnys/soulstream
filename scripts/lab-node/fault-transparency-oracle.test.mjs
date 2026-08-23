import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeliveryObservation,
  buildTransparencyObservation,
  expectedDeliveryObservation,
  expectedTransparencyObservation,
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
  ]);
});

test("an intervention reply that omits the required context is red", () => {
  const expected = expectedTransparencyObservation("intervention");
  const input = observationInput();
  input.timeline.messages[5].payload.content = "INITIAL_OK";
  const actual = buildTransparencyObservation(input);

  assert.deepEqual(transparencyDifferences(expected, actual).map(({ field }) => field), [
    "eventSequence",
    "counts",
  ]);
});

test("the authored intervention contract is not derived from a live baseline", () => {
  assert.deepEqual(expectedTransparencyObservation("intervention"), {
    callerOutcome: { status: "accepted", disposition: "queued_for_next_turn" },
    terminalStatus: "completed",
    eventSequence: [
      "initial_demand",
      "tool_start",
      "intervention_demand",
      "tool_result_ok",
      "initial_reply",
      "context_reply",
    ],
    counts: {
      initialDemand: 1,
      interventionDemand: 1,
      toolStart: 1,
      toolResult: 1,
      toolResultError: 0,
      initialReply: 1,
      contextReply: 1,
      unexpectedAssistantReply: 0,
    },
    visibleErrors: [],
  });
});

test("timeline projection sorts newest-first API rows and finds quoted prompts", () => {
  const input = observationInput();
  input.initialPrompt = 'Use Bash: python3 -c "print(1)"';
  input.timeline.messages[0].payload.text = input.initialPrompt;
  input.timeline.messages.reverse();
  const observation = buildTransparencyObservation(input);

  assert.equal(observation.counts.initialDemand, 1);
  assert.deepEqual(observation.eventSequence, [
    "initial_demand",
    "tool_start",
    "intervention_demand",
    "tool_result_ok",
    "initial_reply",
    "context_reply",
  ]);
});

test("delivery observations reject duplicate execution and missing replies", () => {
  const expected = expectedDeliveryObservation(["only"]);
  const actual = buildDeliveryObservation({
    terminalStatus: "completed",
    callerOutcome: null,
    deliveries: [{ label: "only", text: "DELIVER_ONCE", marker: "ONCE_OK" }],
    timeline: {
      messages: [
        timelineEvent(1, "user_message", { text: "DELIVER_ONCE" }, 0),
        timelineEvent(2, "user_message", { text: "DELIVER_ONCE" }, 0),
      ],
    },
  });

  assert.deepEqual(transparencyDifferences(expected, actual).map(({ field }) => field), [
    "eventSequence",
    "counts",
  ]);
});

test("delivery observations reject FIFO reversal and caller-visible CAS errors", () => {
  const expected = expectedDeliveryObservation(
    ["first", "second"],
    "queued_for_next_turn",
  );
  const actual = buildDeliveryObservation({
    terminalStatus: "completed",
    callerOutcome: {
      status: "rejected",
      reason: { name: "Error", message: "HTTP 503 after durable acceptance" },
    },
    deliveries: [
      { label: "first", text: "FIRST", marker: "FIRST_OK" },
      { label: "second", text: "SECOND", marker: "SECOND_OK" },
    ],
    timeline: {
      messages: [
        timelineEvent(1, "user_message", { text: "SECOND" }, 0),
        timelineEvent(2, "assistant_message", { content: "SECOND_OK" }, 0),
        timelineEvent(3, "user_message", { text: "FIRST" }, 0),
        timelineEvent(4, "assistant_message", { content: "FIRST_OK" }, 0),
      ],
    },
  });

  assert.deepEqual(transparencyDifferences(expected, actual).map(({ field }) => field), [
    "callerOutcome",
    "eventSequence",
  ]);
});

test("delivery observation cursors exclude the setup turn", () => {
  const actual = buildDeliveryObservation({
    afterEventId: 2,
    terminalStatus: "completed",
    callerOutcome: null,
    deliveries: [{ label: "candidate", text: "CANDIDATE", marker: "CANDIDATE_OK" }],
    timeline: {
      messages: [
        timelineEvent(1, "user_message", { text: "BASE" }, 0),
        timelineEvent(2, "assistant_message", { content: "BASE_OK" }, 0),
        timelineEvent(3, "user_message", { text: "CANDIDATE" }, 0),
        timelineEvent(4, "assistant_message", { content: "CANDIDATE_OK" }, 0),
      ],
    },
  });

  assert.deepEqual(actual, expectedDeliveryObservation(["candidate"]));
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
