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
 * Pairing is turn-aware. An intervention received before the active turn's
 * final answer steers that same answer, so one final response closes the
 * original demand and its in-turn interventions together. A successful
 * `session_ended` is a hard turn boundary: a later reply can never be credited
 * to an older unanswered demand. Ordinary user messages remain one-to-one.
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
  const demands = [];
  const open = [];
  let turnEpoch = 0;
  for (const event of ordered) {
    if (DEMAND_EVENT_TYPES.includes(event.event_type)) {
      const demand = {
        eventId: Number(event.id),
        eventType: event.event_type,
        at: event.created_at ?? null,
        excerpt: excerpt(event.text),
        outcome: DEMAND_OUTCOMES.unanswered,
        closedByEventId: null,
        ambiguous: false,
        turnEpoch,
      };
      demands.push(demand);
      open.push(demand);
      continue;
    }
    if (event.event_type === RESPONSE_EVENT_TYPE) {
      if (open.length === 0) continue;
      const currentOpen = open.filter((demand) => demand.turnEpoch === turnEpoch);
      if (currentOpen.length === 0) continue;
      const steeredTurn = currentOpen.some(
        (demand) => demand.eventType === "intervention_sent",
      );
      if (steeredTurn) {
        for (const demand of currentOpen) answer(open, demand, Number(event.id));
        continue;
      }
      if (currentOpen.length > 1) {
        // More than one input was waiting, so which one this reply belongs to
        // is not recoverable from the event stream. Both an earlier draft's
        // FIFO and its LIFO successor were wrong here in opposite directions,
        // and each was wrong *confidently*: FIFO named the recovery turn in a
        // dead-owner run, LIFO names the first turn when a next-turn
        // intervention is what went unanswered. The runtime queue itself
        // drains FIFO within a priority lane
        // (soul-server-ts/src/task/task_intervention_queue.ts), and the events
        // do not carry the lane, so the tie cannot be broken here at all.
        //
        // So the count stays exact -- one reply closes one input either way --
        // and every input that was waiting is marked ambiguous. The verdict
        // then reports "one of these", which is the true statement.
        for (const waiting of currentOpen) waiting.ambiguous = true;
      }
      // FIFO inside the current turn only. A reply after `session_ended` must
      // not make the previous turn's silent loss disappear.
      answer(open, currentOpen[0], Number(event.id));
      continue;
    }
    if (event.event_type === TERMINAL_EVENT_TYPE) {
      if (!isOkTermination(event)) {
        closeAll(open, Number(event.id), event.termination_reason ?? event.ended_status ?? "session_ended");
      }
      turnEpoch += 1;
    }
  }
  if (FAILED_SESSION_STATUSES.has(session.status)) {
    closeAll(open, null, `session status ${session.status}`);
  }
  const working = isStillWorking(session, ordered, now);
  const unanswered = demands.filter(
    (demand) => demand.outcome === DEMAND_OUTCOMES.unanswered,
  );
  // Any input tangled in an ambiguous closure is a candidate for the loss,
  // whether or not the arbitrary FIFO tiebreak happened to leave it open.
  const candidates = unanswered.some((demand) => demand.ambiguous)
    ? demands.filter((demand) => demand.ambiguous || demand.outcome === DEMAND_OUTCOMES.unanswered)
    : unanswered;
  return {
    sessionId: session.session_id,
    status: session.status,
    // What this verdict is good for, and what it is not.
    //
    // It establishes *that* an input went unanswered and *how many* did, and
    // it bounds the possibilities to `candidates`. It does not identify which
    // one when `ambiguous` is set, and it must not be quoted as if it did:
    // the correlation simply is not in the events. Naming a victim needs a
    // human reading the raw stream, or a runtime that records the link.
    scope: "count_and_candidates_only",
    // A session that may yet answer is neither a loss nor a pass. It is
    // reported as `pending` so a caller can settle and re-sample instead of
    // reading an empty list as proof of health.
    verdict: working ? "pending" : (unanswered.length > 0 ? "unanswered" : "answered"),
    stillWorking: working,
    demandCount: demands.length,
    demands,
    unansweredCount: working ? 0 : unanswered.length,
    ambiguous: unanswered.some((demand) => demand.ambiguous),
    unanswered: working ? [] : unanswered,
    candidates: working ? [] : candidates,
  };
}

/** Runs the pairing over every session and returns only the losses. */
export function findUnansweredDemands(sessions, eventsBySession, now = Date.now()) {
  const losses = [];
  for (const session of sessions) {
    const events = eventsBySession.get(session.session_id) ?? [];
    const paired = pairSessionDemands(session, events, now);
    if (paired.unansweredCount === 0) continue;
    losses.push({
      session_id: paired.sessionId,
      status: paired.status,
      unanswered_count: paired.unansweredCount,
      // True when the events cannot say *which* input was dropped. The count
      // is still exact; only the name is uncertain, and saying so beats
      // naming the wrong one.
      ambiguous: paired.ambiguous,
      candidates: paired.candidates.map((demand) => ({
        event_id: demand.eventId,
        event_type: demand.eventType,
        at: demand.at,
        excerpt: demand.excerpt,
      })),
    });
  }
  return losses;
}

/** Sessions that may still answer, so a caller can settle rather than judge. */
export function findPendingSessions(sessions, eventsBySession, now = Date.now()) {
  return sessions
    .filter((session) => pairSessionDemands(
      session, eventsBySession.get(session.session_id) ?? [], now,
    ).verdict === "pending")
    .map((session) => session.session_id);
}

/**
 * There is no de-duplication here, deliberately.
 *
 * An earlier version collapsed a `user_message` and an `intervention_sent`
 * carrying the same text into one input, on the theory that one intervention
 * is recorded twice -- once when accepted, once when projected into the turn.
 * That theory was never checked against anything.
 *
 * It is false. The two events have disjoint writers: interventions go through
 * `publishInterventionSent`
 * (soul-server-ts/src/task/task_running_intervention_transition.ts) and
 * ordinary input through `task_user_message_events.ts`; no path emits both for
 * one input. Across every session in the lab database -- 273 `user_message`
 * and 3 `intervention_sent` -- there are **zero** cross-type same-text pairs.
 *
 * So the rule only ever fired on inputs that were genuinely distinct, and it
 * fired in the direction that hides losses: send a message, get it answered,
 * send the same words again as an intervention, get nothing, and the judge
 * counted one input and reported clean. Guessing at a mechanism and then
 * writing a rule for the guess is the failure this whole audit is about.
 *
 * Every recorded input counts as an input.
 */

function closeAll(open, eventId, reason) {
  while (open.length > 0) {
    const demand = open.shift();
    demand.outcome = DEMAND_OUTCOMES.explicitFailure;
    demand.closedByEventId = eventId;
    demand.failureReason = reason;
  }
}

function answer(open, demand, eventId) {
  const index = open.indexOf(demand);
  if (index >= 0) open.splice(index, 1);
  demand.outcome = DEMAND_OUTCOMES.answered;
  demand.closedByEventId = eventId;
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
