import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMAND_OUTCOMES,
  findPendingSessions,
  findUnansweredDemands,
  pairSessionDemands,
} from "./fault-harness-verdict.mjs";

const NOW = Date.parse("2026-08-22T16:00:00.000Z");
const LONG_AGO = "2026-08-22T15:00:00.000Z";

function session(overrides = {}) {
  return {
    session_id: "session-under-test",
    status: "completed",
    last_event_at: LONG_AGO,
    ...overrides,
  };
}

let nextId = 0;
function event(event_type, extra = {}) {
  nextId += 1;
  return { id: nextId, event_type, created_at: LONG_AGO, ...extra };
}

function stream(...events) {
  nextId = 0;
  return events;
}

// --- the judge answering for itself -----------------------------------------
//
// Each of these plants one violation and requires the judge to name it. A
// judge that stays green under a planted violation is not a gate, and the
// point of writing them down is that the next person to weaken one trips over
// a red test instead of a clean scorecard.

test("clean session: one input, one reply", () => {
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "do the thing" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.deepEqual(paired.unanswered, []);
  assert.equal(paired.demands[0].outcome, DEMAND_OUTCOMES.answered);
});

test("MUTATION: a dropped first turn is red even though a later reply exists", () => {
  // The shape every passing dead-owner run actually had: the first message
  // dies with its runner, the recovery message is answered, and the session
  // reports `completed`. The judge this replaces compared newest input against
  // newest reply and called it clean.
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "sleep 30 then say OLD" }),
      event("user_message", { text: "say RECOVERED" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.unansweredCount, 1);
  // Two inputs were waiting when the single reply arrived, so which one it
  // answered is not in the events. The count is exact; the name is a set.
  assert.equal(paired.ambiguous, true);
  assert.deepEqual(
    paired.candidates.map((demand) => demand.excerpt).sort(),
    ["say RECOVERED", "sleep 30 then say OLD"],
  );
});

test("an in-turn intervention is folded into the one final response", () => {
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "sleep 12 then say INITIAL" }),
      event("intervention_sent", { text: "say INTERVENTION" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.demandCount, 2);
  assert.equal(paired.unanswered.length, 0);
  assert.deepEqual(
    paired.demands.map(({ outcome }) => outcome),
    [DEMAND_OUTCOMES.answered, DEMAND_OUTCOMES.answered],
  );
});

test("MUTATION: a later intervention reply cannot hide the previous turn's loss", () => {
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "sleep 90 then say INITIAL" }),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
      event("intervention_sent", { text: "say RECOVERED" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.unanswered.length, 1);
  assert.equal(paired.unanswered[0].excerpt, "sleep 90 then say INITIAL");
});

test("MUTATION: a later turn's reply cannot hide a swallowed intervention", () => {
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "first turn" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
      event("intervention_sent", { text: "swallowed steer" }),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
      event("user_message", { text: "later turn" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.unansweredCount, 1);
  assert.equal(paired.ambiguous, false);
  assert.deepEqual(
    paired.candidates.map(({ eventType, excerpt }) => ({ eventType, excerpt })),
    [{ eventType: "intervention_sent", excerpt: "swallowed steer" }],
  );
});

test("MUTATION: a session with no reply at all is red", () => {
  const paired = pairSessionDemands(
    session(),
    stream(event("user_message", { text: "answer me" })),
    NOW,
  );
  assert.equal(paired.unanswered.length, 1);
});

test("an explicit failure closes the open inputs it lost", () => {
  // The contract is "reply *or* visible failure". A session the user can see
  // ended badly has failed visibly, so it is not a silent loss.
  const paired = pairSessionDemands(
    session({ status: "error" }),
    stream(
      event("user_message", { text: "answer me" }),
      event("session_ended", { ended_status: "error", termination_reason: "error_aborted" }),
    ),
    NOW,
  );
  assert.deepEqual(paired.unanswered, []);
  assert.equal(paired.demands[0].outcome, DEMAND_OUTCOMES.explicitFailure);
});

test("a completed session does not get the same forgiveness", () => {
  // Reporting success while an input went unanswered is the silent loss this
  // judge exists for, so `completed` must not close anything.
  const paired = pairSessionDemands(
    session({ status: "completed" }),
    stream(
      event("user_message", { text: "answer me" }),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.unanswered.length, 1);
});

test("REVIEW: two recorded inputs are two inputs, whatever their wording", () => {
  // This asserted the opposite until the second review checked the premise.
  // The judge used to fold a `user_message` and an `intervention_sent` with
  // matching text into one input, assuming one intervention gets recorded
  // twice. It does not: the two events have disjoint writers, and across every
  // session in the lab database -- 273 user messages, 3 interventions -- there
  // is not one cross-type same-text pair. The rule only ever fired on
  // genuinely separate inputs, and it fired in the direction that hides a loss.
  const paired = pairSessionDemands(
    session(),
    stream(
      event("intervention_sent", { text: "say INTERVENTION" }),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
      event("user_message", { text: "say INTERVENTION" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.demandCount, 2);
  assert.equal(paired.unansweredCount, 1);
});

test("the same text sent twice as the same kind stays two inputs", () => {
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "say IT" }),
      event("user_message", { text: "say IT" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.demandCount, 2);
  assert.equal(paired.unanswered.length, 1);
});

test("a session still working is neither a loss nor a pass", () => {
  const paired = pairSessionDemands(
    session({ status: "running", last_event_at: new Date(NOW - 1_000).toISOString() }),
    stream(event("user_message", { text: "answer me" })),
    NOW,
  );
  assert.equal(paired.stillWorking, true);
  assert.deepEqual(paired.unanswered, []);
});

test("a quiet running session is a loss, because that is the stall being hunted", () => {
  const paired = pairSessionDemands(
    session({ status: "running", last_event_at: new Date(NOW - 120_000).toISOString() }),
    stream(event("user_message", { text: "answer me" })),
    NOW,
  );
  assert.equal(paired.stillWorking, false);
  assert.equal(paired.unanswered.length, 1);
});

test("a live runner exempts its session even when the database looks quiet", () => {
  const paired = pairSessionDemands(
    session({
      status: "running",
      last_event_at: new Date(NOW - 120_000).toISOString(),
      runnerProgressing: true,
    }),
    stream(event("user_message", { text: "answer me" })),
    NOW,
  );
  assert.equal(paired.stillWorking, true);
});

test("events arriving out of order are paired by id, not by arrival", () => {
  const paired = pairSessionDemands(
    session(),
    [
      { id: 3, event_type: "assistant_message", created_at: LONG_AGO },
      { id: 1, event_type: "user_message", text: "first", created_at: LONG_AGO },
      { id: 2, event_type: "user_message", text: "second", created_at: LONG_AGO },
    ],
    NOW,
  );
  assert.equal(paired.unansweredCount, 1);
  assert.equal(paired.ambiguous, true);
});

test("findUnansweredDemands reports across sessions and names each one", () => {
  const losses = findUnansweredDemands(
    [session({ session_id: "a" }), session({ session_id: "b" })],
    new Map([
      ["a", [{ id: 1, event_type: "user_message", text: "lost", created_at: LONG_AGO }]],
      ["b", [
        { id: 1, event_type: "user_message", text: "kept", created_at: LONG_AGO },
        { id: 2, event_type: "assistant_message", created_at: LONG_AGO },
      ]],
    ]),
    NOW,
  );
  assert.equal(losses.length, 1);
  assert.equal(losses[0].session_id, "a");
  assert.equal(losses[0].unanswered_count, 1);
  assert.equal(losses[0].ambiguous, false);
  assert.deepEqual(losses[0].candidates.map((c) => c.event_id), [1]);
});

// --- the discriminating pair, taken from real lab evidence -------------------
//
// Two traffic-cycle sessions with the identical shape -- three inputs, two
// replies -- and opposite verdicts. Everything about them matches except the
// terminal marker on the middle turn, so these two tests pin the exact line
// the judge draws. They use the values observed in the lab on 2026-08-22
// rather than invented ones, because the whole point of the audit was that
// invented inputs proved nothing.

test("cycle shape: a deliberate interrupt that the system reported is not a loss", () => {
  // 314379d8-a2f0-4168-b6b1-712c30e51a1a -- judged green.
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "Reply with exactly CYCLE_INITIAL." }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
      event("user_message", { text: "sleep 12 then reply CYCLE_CANCELLED." }),
      event("session_ended", { ended_status: "interrupted", termination_reason: "killed" }),
      event("user_message", { text: "Reply with exactly CYCLE_FINAL." }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.demandCount, 3);
  assert.deepEqual(paired.unanswered, []);
  assert.equal(paired.demands[1].outcome, DEMAND_OUTCOMES.explicitFailure);
});

test("cycle shape: the same turn swallowed and reported completed IS a loss", () => {
  // d3ee976f-34de-4649-921c-3afbb032b373 -- judged red under load. Identical
  // to the case above except that the middle turn ended `completed_ok` with
  // no tool call, no reply and no error.
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "Reply with exactly CYCLE_INITIAL." }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
      event("user_message", { text: "sleep 12 then reply CYCLE_CANCELLED." }),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.unanswered.length, 1);
  assert.equal(paired.unanswered[0].excerpt, "sleep 12 then reply CYCLE_CANCELLED.");
});


// --- the two cases the independent review planted and this judge failed -----

test("REVIEW P1-1: the same wording sent again after a reply is a separate input", () => {
  // Planted in the lab by the reviewer: a user message answered normally, then
  // a distinct intervention worded identically that never got an answer. The
  // first dedupe matched the same text anywhere in the session, wrote the
  // second one off as a projection of the first, and returned green on a real
  // loss.
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "same text" }),
      event("assistant_message"),
      event("intervention_sent", { text: "same text" }),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.demandCount, 2);
  assert.equal(paired.unansweredCount, 1);
  assert.equal(paired.ambiguous, false);
  assert.deepEqual(paired.candidates.map((demand) => demand.eventType), ["intervention_sent"]);
});

test("REVIEW: the verdict declares what it is not good for", () => {
  // The review accepted the ambiguity handling on one condition: that the
  // result never be quoted as identifying a victim. Saying so in the payload
  // means a consumer cannot claim it by accident.
  const paired = pairSessionDemands(session(), stream(event("user_message", { text: "x" })), NOW);
  assert.equal(paired.scope, "count_and_candidates_only");
});

test("an in-turn next-turn ACK still steers the one final response", () => {
  // Claude labels this caller ACK `next_turn`, but the persisted event remains
  // inside the active turn before its final assistant response. The scenario
  // marker proves whether B was actually reflected; the generic count judge
  // must not require a second assistant response that the contract forbids.
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "A" }),
      event("intervention_sent", { text: "B" }),
      event("assistant_message"),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.unansweredCount, 0);
  assert.equal(paired.ambiguous, false);
});

test("REVIEW P2-2: a session that may still answer reports pending, not clean", () => {
  const paired = pairSessionDemands(
    session({ status: "running", last_event_at: new Date(NOW - 1_000).toISOString() }),
    stream(event("user_message", { text: "answer me" })),
    NOW,
  );
  assert.equal(paired.verdict, "pending");
  assert.equal(paired.unansweredCount, 0);
  assert.equal(paired.demandCount, 1);
});

test("an unambiguous single loss still names exactly one input", () => {
  // Ambiguity must not become the answer to everything: when only one input
  // was ever waiting, the judge still says which.
  const paired = pairSessionDemands(
    session(),
    stream(
      event("user_message", { text: "answered one" }),
      event("assistant_message"),
      event("user_message", { text: "dropped one" }),
      event("session_ended", { ended_status: "completed", termination_reason: "completed_ok" }),
    ),
    NOW,
  );
  assert.equal(paired.unansweredCount, 1);
  assert.equal(paired.ambiguous, false);
  assert.deepEqual(paired.candidates.map((demand) => demand.excerpt), ["dropped one"]);
});


test("REVIEW P1-1(2nd): pending sessions are enumerated for the sampler to consume", () => {
  // `pending` existed as a returned string and nothing read it, so a session
  // with a fresh input and a live runner produced neither a violation nor any
  // other signal and the sample came back clean. The sampler now settles on
  // this list, so it has to be reachable from outside the module.
  const working = { session_id: "live", status: "running", runnerProgressing: true };
  const quiet = { session_id: "quiet", status: "completed", last_event_at: LONG_AGO };
  const events = new Map([
    ["live", [{ id: 1, event_type: "user_message", text: "hi", created_at: LONG_AGO }]],
    ["quiet", [{ id: 1, event_type: "user_message", text: "hi", created_at: LONG_AGO }]],
  ]);
  assert.deepEqual(findPendingSessions([working, quiet], events, NOW), ["live"]);
  // And a pending session is not also counted as a loss.
  const losses = findUnansweredDemands([working, quiet], events, NOW);
  assert.deepEqual(losses.map((loss) => loss.session_id), ["quiet"]);
});

test("REVIEW P1-2(2nd): the verdict follows the clock it is given, not the wall", () => {
  // A stored capture has to be judged with the capture's clock. Judged with
  // `Date.now()`, a session that was legitimately mid-answer turns red purely
  // because time passed between the run and the replay.
  const capturedAt = Date.parse("2026-08-22T15:59:59.000Z");
  const midAnswer = session({
    status: "running",
    last_event_at: "2026-08-22T15:59:50.000Z",
  });
  const events = stream(event("user_message", { text: "answer me" }));
  assert.equal(pairSessionDemands(midAnswer, events, capturedAt).verdict, "pending");
  // Same inputs, replayed an hour later with the wrong clock.
  assert.equal(
    pairSessionDemands(midAnswer, events, capturedAt + 3_600_000).verdict,
    "unanswered",
  );
});
