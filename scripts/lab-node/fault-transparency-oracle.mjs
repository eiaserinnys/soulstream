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
    ? input.timeline.messages
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
    if (eventType === "user_message" && text.includes(input.initialPrompt)) {
      counts.initialDemand += 1;
      eventSequence.push("initial_demand");
    }
    if (
      input.interventionText
      && eventType === "intervention_sent"
      && text.includes(input.interventionText)
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
    }
    if (
      input.contextMarker
      && eventType === "assistant_message"
      && text.includes(input.contextMarker)
    ) {
      counts.contextReply += 1;
      eventSequence.push("context_reply");
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

export function transparencyDifferences(baseline, candidate) {
  const differences = [];
  compareField(differences, "callerOutcome", baseline, candidate);
  compareField(differences, "terminalStatus", baseline, candidate);
  compareField(differences, "eventSequence", baseline, candidate);
  compareField(differences, "counts", baseline, candidate);
  compareField(differences, "visibleErrors", baseline, candidate);
  compareField(differences, "visibleSignals", baseline, candidate);
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
  return {
    status: "fulfilled",
    value: stripVolatile(outcome.value),
  };
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
