const VOLATILE_KEY = /(^|_)(id|at|time|timestamp|duration|elapsed|latency)(_|$)|(?:Id|At|Time|Timestamp|Duration|Elapsed|Latency)(?:Ms)?$/;
const RESTART_VISIBLE_SIGNAL = /(?:\b503\b|restart|reconnect|re-?send|retry|unavailable|reset|context\s+lost|재시작|재기동|다시\s*보내|재시도|컨텍스트.{0,8}유실)/i;

/**
 * Canonical user/agent-visible contract for one normal or restart run.
 *
 * Wall-clock time and request identity are deliberately absent. Delay is the
 * only restart effect the acceptance contract permits; every other signal is
 * compared by transparencyDifferences.
 */
export function buildTransparencyObservation(input) {
  const messages = Array.isArray(input.timeline?.messages)
    ? [...input.timeline.messages].sort((left, right) => (
        Number(left?.event_id ?? left?.id ?? 0) - Number(right?.event_id ?? right?.id ?? 0)
      ))
    : [];
  const eventSequence = [];
  const counts = {
    initialDemand: 0,
    interventionDemand: 0,
    toolStart: 0,
    toolResult: 0,
    toolResultError: 0,
    initialReply: 0,
    contextReply: 0,
    unexpectedAssistantReply: 0,
  };
  const visibleErrors = [];
  const visibleSignals = [];

  for (const message of messages) {
    const eventType = String(message?.event_type ?? message?.eventType ?? "");
    const text = JSON.stringify(message?.payload ?? {});
    if (USER_AGENT_VISIBLE_EVENTS.has(eventType)) {
      visibleSignals.push({
        eventType,
        payload: normalizeVisiblePayload(message?.payload, input),
      });
    }
    if (eventType === "user_message") {
      if (payloadContains(message?.payload, input.initialPrompt)) {
        counts.initialDemand += 1;
        eventSequence.push("initial_demand");
      } else {
        eventSequence.push("unexpected_user_demand");
      }
    }
    if (
      input.interventionText
      && eventType === "intervention_sent"
      && payloadContains(message?.payload, input.interventionText)
    ) {
      counts.interventionDemand += 1;
      eventSequence.push("intervention_demand");
    }
    if (eventType === "tool_start") {
      counts.toolStart += 1;
      eventSequence.push("tool_start");
    }
    if (eventType === "tool_result") {
      counts.toolResult += 1;
      const errored = toolResultErrored(message?.payload);
      if (errored) counts.toolResultError += 1;
      eventSequence.push(errored ? "tool_result_error" : "tool_result_ok");
    }
    if (eventType === "assistant_message" && text.includes(input.initialMarker)) {
      counts.initialReply += 1;
      eventSequence.push("initial_reply");
    } else if (
      input.contextMarker
      && eventType === "assistant_message"
      && text.includes(input.contextMarker)
    ) {
      counts.contextReply += 1;
      eventSequence.push("context_reply");
    } else if (eventType === "assistant_message") {
      counts.unexpectedAssistantReply += 1;
      eventSequence.push("unexpected_assistant_reply");
    }
    if (
      eventType === "error"
      || eventType === "assistant_error"
      || (["assistant_message", "system", "system_message"].includes(eventType)
        && RESTART_VISIBLE_SIGNAL.test(text))
    ) {
      visibleErrors.push({ eventType, text });
    }
  }

  return {
    callerOutcome: normalizeCallerOutcome(input.callerOutcome),
    terminalStatus: input.terminalStatus,
    eventSequence,
    counts,
    visibleErrors,
    visibleSignals,
  };
}

export function expectedTransparencyObservation(kind) {
  if (kind === "general") {
    return {
      callerOutcome: { status: "accepted", disposition: "session_created" },
      terminalStatus: "completed",
      eventSequence: ["initial_demand", "tool_start", "tool_result_ok", "initial_reply"],
      counts: {
        initialDemand: 1,
        interventionDemand: 0,
        toolStart: 1,
        toolResult: 1,
        toolResultError: 0,
        initialReply: 1,
        contextReply: 0,
        unexpectedAssistantReply: 0,
      },
      visibleErrors: [],
    };
  }
  if (kind === "intervention") {
    return {
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
    };
  }
  throw new Error(`unknown transparency observation kind: ${kind}`);
}

/**
 * Projects one or more durable-delivery turns onto the same stable semantic
 * surface used by the restart transparency scenarios.
 *
 * Delivery ids and timestamps are transport details. Labels are authored by
 * the scenario (for example, "first" and "second") so duplicate or reordered
 * user demands and replies remain visible without comparing random markers.
 */
export function buildDeliveryObservation(input) {
  const specs = Array.isArray(input.deliveries) ? input.deliveries : [];
  const afterEventId = Number(input.afterEventId ?? 0);
  const messages = Array.isArray(input.timeline?.messages)
    ? [...input.timeline.messages]
      .filter((message) => Number(message?.event_id ?? message?.id ?? 0) > afterEventId)
      .sort((left, right) => (
        Number(left?.event_id ?? left?.id ?? 0) - Number(right?.event_id ?? right?.id ?? 0)
      ))
    : [];
  const counts = {
    demands: Object.fromEntries(specs.map(({ label }) => [label, 0])),
    replies: Object.fromEntries(specs.map(({ label }) => [label, 0])),
    unexpectedDemand: 0,
    unexpectedReply: 0,
  };
  const eventSequence = [];
  const visibleErrors = [];

  for (const message of messages) {
    const eventType = String(message?.event_type ?? message?.eventType ?? "");
    const text = JSON.stringify(message?.payload ?? {});
    if (eventType === "user_message") {
      const spec = specs.find((candidate) => payloadContains(message?.payload, candidate.text));
      if (spec) {
        counts.demands[spec.label] += 1;
        eventSequence.push(`demand:${spec.label}`);
      } else {
        counts.unexpectedDemand += 1;
        eventSequence.push("unexpected_demand");
      }
    }
    if (eventType === "assistant_message") {
      const spec = specs.find((candidate) => payloadContains(message?.payload, candidate.marker));
      if (spec) {
        counts.replies[spec.label] += 1;
        eventSequence.push(`reply:${spec.label}`);
      } else {
        counts.unexpectedReply += 1;
        eventSequence.push("unexpected_reply");
      }
    }
    if (
      eventType === "error"
      || eventType === "assistant_error"
      || (["assistant_message", "system", "system_message"].includes(eventType)
        && RESTART_VISIBLE_SIGNAL.test(text))
    ) {
      visibleErrors.push({ eventType, text });
    }
  }

  return {
    callerOutcome: normalizeCallerOutcome(input.callerOutcome),
    terminalStatus: input.terminalStatus,
    eventSequence,
    counts,
    visibleErrors,
  };
}

export function expectedDeliveryObservation(labels, callerDisposition = null) {
  return {
    callerOutcome: callerDisposition === null
      ? null
      : { status: "accepted", disposition: callerDisposition },
    terminalStatus: "completed",
    eventSequence: labels.flatMap((label) => [`demand:${label}`, `reply:${label}`]),
    counts: {
      demands: Object.fromEntries(labels.map((label) => [label, 1])),
      replies: Object.fromEntries(labels.map((label) => [label, 1])),
      unexpectedDemand: 0,
      unexpectedReply: 0,
    },
    visibleErrors: [],
  };
}

export function transparencyDifferences(baseline, candidate) {
  const differences = [];
  compareField(differences, "callerOutcome", baseline, candidate);
  compareField(differences, "terminalStatus", baseline, candidate);
  compareField(differences, "eventSequence", baseline, candidate);
  compareField(differences, "counts", baseline, candidate);
  compareField(differences, "visibleErrors", baseline, candidate);
  return differences;
}

const USER_AGENT_VISIBLE_EVENTS = new Set([
  "user_message",
  "intervention_sent",
  "assistant_message",
  "tool_start",
  "tool_result",
  "error",
  "assistant_error",
  "system",
  "system_message",
  "credential_alert",
  "result",
  "context_usage",
  "complete",
  "session_ended",
  "session",
  "subagent_start",
  "subagent_stop",
  "claude_runtime_task_started",
  "claude_runtime_task_notification",
  "claude_runtime_hook_event",
]);

function normalizeVisiblePayload(payload, input) {
  const replacements = [
    [input.initialPrompt, "<INITIAL_PROMPT>"],
    [input.interventionText, "<INTERVENTION_PROMPT>"],
    [input.initialMarker, "<INITIAL_MARKER>"],
    [input.contextMarker, "<CONTEXT_MARKER>"],
    [input.contextToken, "<CONTEXT_TOKEN>"],
  ].filter(([from]) => typeof from === "string" && from.length > 0);
  return replaceStrings(stripVolatile(payload), replacements);
}

function replaceStrings(value, replacements) {
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, replacements));
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return replacements.reduce(
      (text, [from, to]) => text.replaceAll(from, to),
      value,
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, replaceStrings(nested, replacements)]),
  );
}

function normalizeCallerOutcome(outcome) {
  if (outcome === null || outcome === undefined) return null;
  if (outcome.status === "rejected") {
    return {
      status: "rejected",
      reason: stripVolatile(outcome.reason),
    };
  }
  const value = outcome.value ?? {};
  const disposition = value.outcome === "queued" || value.consumeWhen === "next_turn"
    ? "queued_for_next_turn"
    : (value.outcome === "delivered" || value.delivered === true
      ? "delivered"
      : (value.accepted === true ? "session_created" : "unknown"));
  const restartVisible = RESTART_VISIBLE_SIGNAL.test(JSON.stringify(stripVolatile(value)));
  return {
    status: "accepted",
    disposition,
    ...(restartVisible ? { restartVisible: true } : {}),
  };
}

function payloadContains(value, needle) {
  if (typeof needle !== "string" || needle.length === 0) return false;
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((entry) => payloadContains(entry, needle));
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((entry) => payloadContains(entry, needle));
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_KEY.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stripVolatile(nested)]),
  );
}

function toolResultErrored(payload) {
  if (payload === null || typeof payload !== "object") return false;
  return payload.is_error === true
    || payload.status === "error"
    || (payload.error !== undefined && payload.error !== null);
}

function compareField(differences, field, baseline, candidate) {
  if (stableJson(baseline[field]) === stableJson(candidate[field])) return;
  differences.push({
    field,
    baseline: baseline[field],
    candidate: candidate[field],
  });
}

function stableJson(value) {
  return JSON.stringify(value);
}
