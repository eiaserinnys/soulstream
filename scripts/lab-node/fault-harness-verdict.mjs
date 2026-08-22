/**
 * The one verdict a user can check: every input they sent got an answer or an
 * explicit failure.
 *
 * The judge this replaces compared the *last* `user_message` id against the
 * *last* `assistant_message` id per session. Two inputs and one reply passed
 * that test, because the one reply was newer than both inputs -- a later
 * answer covered an earlier loss. It also read only `user_message`, so an
 * intervention that was persisted as `intervention_sent` and never projected
 * was invisible to it: the exact loss the F11 scenario exists to catch.
 *
 * So the pairing here is positional, not extremal. Inputs queue; each reply
 * closes the oldest input still open; whatever is still open when the session
 * goes quiet is a loss, and it is named with the event that was dropped.
 */

export const DEMAND_EVENT_TYPES = Object.freeze(["user_message", "intervention_sent"]);
export const RESPONSE_EVENT_TYPE = "assistant_message";
export const TERMINAL_EVENT_TYPE = "session_ended";

/** The only ending that promises the work was carried out. */
const OK_TERMINATION_REASONS = new Set(["completed_ok"]);

/**
 * Session states a user can see went wrong.
 *
 * These close every open input as an *explicit* failure: the contract is
 * "answer or visible failure", and a session the user can see ended badly is
 * the visible failure. `completed` is deliberately absent -- a session that
 * reports success while an input went unanswered is precisely the silent loss
 * this judge exists to name.
 */
const FAILED_SESSION_STATUSES = new Set([
  "error",
  "failed",
  "interrupted",
  "cancelled",
  "killed",
]);

const WORKING_SESSION_STATUSES = new Set(["running", "initializing"]);

/** How long a quiet session is given before its open inputs count as lost. */
export const QUIET_GRACE_MS = 30_000;

export const DEMAND_OUTCOMES = Object.freeze({
  answered: "answered",
  explicitFailure: "explicit_failure",
  unanswered: "unanswered",
});

/**
 * Pairs one session's inputs against its replies.
 *
 * `events` needs only the four event types above; anything else is ignored.
 * Each event is `{ id, event_type, text, ended_status, termination_reason,
 * created_at }`.
 */
export function pairSessionDemands(session, events, now = Date.now()) {
  const ordered = [...events].sort((left, right) => Number(left.id) - Number(right.id));
  const suppressed = findProjectionDuplicates(ordered);
  const demands = [];
  const open = [];
  for (const event of ordered) {
    if (DEMAND_EVENT_TYPES.includes(event.event_type)) {
      if (suppressed.has(Number(event.id))) continue;
      const demand = {
        eventId: Number(event.id),
        eventType: event.event_type,
        at: event.created_at ?? null,
        excerpt: excerpt(event.text),
        outcome: DEMAND_OUTCOMES.unanswered,
        closedByEventId: null,
      };
      demands.push(demand);
      open.push(demand);
      continue;
    }
    if (event.event_type === RESPONSE_EVENT_TYPE) {
      // The newest open input, because that is what the runtime actually
      // answers: an input arriving mid-turn interrupts and supersedes, and the
      // next reply belongs to it. Closing the oldest instead keeps the same
      // *count* but names the wrong event -- it reported the recovery
      // intervention lost in a dead-owner run where the reply to that
      // intervention is sitting three events later, and the message actually
      // dropped was the interrupted first turn. A judge that names the wrong
      // victim gets argued with instead of acted on.
      //
      // This is not the extremal comparison it replaces: that one asked only
      // whether *some* reply was newer than *some* input, so one reply cleared
      // every input at once. Here each reply closes exactly one.
      const demand = open.pop();
      if (demand) {
        demand.outcome = DEMAND_OUTCOMES.answered;
        demand.closedByEventId = Number(event.id);
      }
      continue;
    }
    if (event.event_type === TERMINAL_EVENT_TYPE && !isOkTermination(event)) {
      closeAll(open, Number(event.id), event.termination_reason ?? event.ended_status ?? "session_ended");
    }
  }
  if (FAILED_SESSION_STATUSES.has(session.status)) {
    closeAll(open, null, `session status ${session.status}`);
  }
  const working = isStillWorking(session, ordered, now);
  return {
    sessionId: session.session_id,
    status: session.status,
    stillWorking: working,
    demandCount: demands.length,
    demands,
    // A session that may yet answer is not a loss. It is also not a pass: the
    // caller settles and re-samples rather than recording either.
    unanswered: working
      ? []
      : demands.filter((demand) => demand.outcome === DEMAND_OUTCOMES.unanswered),
  };
}

/** Runs the pairing over every session and returns only the losses. */
export function findUnansweredDemands(sessions, eventsBySession, now = Date.now()) {
  const losses = [];
  for (const session of sessions) {
    const events = eventsBySession.get(session.session_id) ?? [];
    const paired = pairSessionDemands(session, events, now);
    for (const demand of paired.unanswered) {
      losses.push({
        session_id: paired.sessionId,
        status: paired.status,
        demand_event_id: demand.eventId,
        demand_event_type: demand.eventType,
        demand_at: demand.at,
        excerpt: demand.excerpt,
      });
    }
  }
  return losses;
}

/**
 * Event ids of inputs that are a second recording of an input already counted.
 *
 * One intervention can land twice: once as `intervention_sent` when it is
 * accepted and once as `user_message` when it is projected into the turn.
 * Counting both would demand two replies for one input and turn a healthy
 * session red -- a judge that cries wolf gets switched off, which is how the
 * previous one ended up being ignored. Two inputs of the *same* type with the
 * same text stay two inputs: a genuine duplicate send is not a projection.
 */
function findProjectionDuplicates(ordered) {
  const seen = new Map();
  const suppressed = new Set();
  for (const event of ordered) {
    if (!DEMAND_EVENT_TYPES.includes(event.event_type)) continue;
    const key = normalizeText(event.text);
    if (key === "") continue;
    const previous = seen.get(key);
    if (previous && previous.event_type !== event.event_type) {
      suppressed.add(Number(event.id));
      continue;
    }
    if (!previous) seen.set(key, event);
  }
  return suppressed;
}

function closeAll(open, eventId, reason) {
  while (open.length > 0) {
    const demand = open.shift();
    demand.outcome = DEMAND_OUTCOMES.explicitFailure;
    demand.closedByEventId = eventId;
    demand.failureReason = reason;
  }
}

function isOkTermination(event) {
  const reason = event.termination_reason ?? null;
  if (reason !== null) return OK_TERMINATION_REASONS.has(reason);
  return event.ended_status === "completed";
}

/**
 * Whether the session may still produce the missing reply.
 *
 * Central status alone is not enough: a session stuck in `running` with a dead
 * runner is exactly the failure being hunted, and exempting it would make the
 * judge blind to its own subject. So a working session must also have emitted
 * something recently.
 */
function isStillWorking(session, ordered, now) {
  // Set by the live sampler from the runner lifecycle on disk. A runner whose
  // `progress_at` is still moving is genuinely mid-answer, and no clock over
  // the database can see that.
  if (session.runnerProgressing === true) return true;
  if (!WORKING_SESSION_STATUSES.has(session.status)) return false;
  const lastEventAt = Date.parse(
    session.last_event_at ?? ordered.at(-1)?.created_at ?? "",
  ) || 0;
  return now - lastEventAt < QUIET_GRACE_MS;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function excerpt(value) {
  const text = normalizeText(value);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}
