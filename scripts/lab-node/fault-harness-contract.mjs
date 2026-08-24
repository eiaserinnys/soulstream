import { createHash } from "node:crypto";

export const SCENARIO_DEFINITIONS = Object.freeze({
  "steady-state": Object.freeze({
    injection: "None. Exercise one ordinary turn and one in-flight Claude intervention turn.",
    expectedOutcome: "Each demand and tool result appears once; Claude queues the intervention for the next turn and completes it once.",
    verdict: "Both observations match the user-authored semantic contract; current live behavior never defines that contract.",
  }),
  "auto-resume-handoff": Object.freeze({
    injection: "Complete a child while its caller is finishing a turn, so the completion delivery opens the next turn without human delay.",
    expectedOutcome: "The caller's live runner consumes the completion exactly once and produces a second response without a replacement spawn.",
    verdict: "The completion receipt and consumption occur once, exactly one new turn completes, and the runner pid stays unchanged.",
  }),
  "restart-adopt": Object.freeze({
    injection: "Restart the node on the same release and manifest while a 90-second tool is actually in flight.",
    expectedOutcome: "The host adopts the same runner and the original turn completes exactly once without a restart-visible signal.",
    verdict: "The user/agent-visible observation is identical to the steady general baseline; only delay may differ.",
  }),
  "restart-intervention-window": Object.freeze({
    injection: "Pause the observed identity-proven to active adoption transition and force the recovery-time queued-state CAS race, then submit one durable intervention.",
    expectedOutcome: "The intervention is accepted and consumed exactly once after recovery without retry or any restart-visible signal.",
    verdict: "The user/agent-visible observation is identical to the steady intervention baseline; only delay may differ.",
  }),
  "restart-window-durable": Object.freeze({
    injection: "Submit one intervention while the owning node is stopped, before its replacement host registers.",
    expectedOutcome: "The API durably accepts the message, and the restarted node consumes and answers it exactly once.",
    verdict: "The central delivery reaches consumed, its intervention receipt and response occur once, and no runner inbox or execution remains in flight.",
  }),
  "delivery-revival": Object.freeze({
    injection: "Park a durable user delivery as uncertain at attempt 16, then make it due for recovery.",
    expectedOutcome: "The target auto-resumes and consumes the original delivery without a second user send.",
    verdict: "The user-visible observation matches one steady turn, and the original delivery reaches consumed exactly once.",
  }),
  "delivery-exact-once": Object.freeze({
    injection: "Submit two transport deliveries with one stable logical message identity around a delayed target turn.",
    expectedOutcome: "Both requests converge on one logical delivery and one execution.",
    verdict: "The user-visible observation matches one steady turn: one demand and one assistant marker.",
  }),
  "delivery-fifo": Object.freeze({
    injection: "Make a newer durable delivery due before its older predecessor.",
    expectedOutcome: "The newer row waits until the older row is consumed.",
    verdict: "The user-visible observation matches two steady turns in enqueue order, and receipt ids preserve that order.",
  }),
  "delivery-accepted-cas": Object.freeze({
    injection: "Advance a dispatching delivery to queued in an AFTER UPDATE fault trigger before the route records its result.",
    expectedOutcome: "The request reports durable acceptance instead of a 503/CAS failure.",
    verdict: "The accepted call and user-visible observation match a steady turn, and the delivery consumes once.",
  }),
  F1: Object.freeze({
    modes: Object.freeze(["SIGTERM", "SIGKILL"]),
    injection: "Stop the worker host during an active runner turn, restart it, and retain the detached runner.",
    expectedOutcome: "Both graceful and hard host loss converge to one completed assistant marker.",
    verdict: "The original runner pid survives, the marker appears once, and post-fault invariants are clean.",
  }),
  F11: Object.freeze({
    injection: "Restart the orchestrator while a stable-id intervention request is in flight, then retry the same delivery id.",
    expectedOutcome: "The worker re-registers and the intervention is consumed exactly once.",
    verdict: "One user message and one assistant marker exist for the stable delivery id, with no overdue delivery.",
  }),
  F9: Object.freeze({
    injection: "Rebuild the host with a different declared release identity while an old-release runner remains live.",
    expectedOutcome: "The new host attaches the live old runner and a restart-window message is consumed by that runner exactly once.",
    verdict: "Both turn markers appear once on the original runner pid, with no mismatch, terminalization, or replacement evidence.",
  }),
  "dead-owner": Object.freeze({
    injection: "Freeze the host, SIGKILL a live runner, crash the host before cleanup, hide the dead registration, then send the next message.",
    expectedOutcome: "The dead owner expires and a new ownership generation executes the next turn.",
    verdict: "The old generation is failed with dead-owner evidence and a later generation reaches terminal.",
  }),
  "runner-death-live-host": Object.freeze({
    injection: "SIGTERM an in-flight runner and remove its registration while the host remains live and no caller sends more work.",
    expectedOutcome: "The active turn settles by itself before any reserve, intervention, or host restart.",
    verdict: "A post-fault host snapshot no longer contains the session operation, the session is terminal, and only then a later turn completes once on a replacement runner.",
  }),
  "activate-rollback": Object.freeze({
    injection: "Delay and reject activation in the lab database while replacing runner.pid with conflicting live pid evidence.",
    expectedOutcome: "The failed activation leaves no spawned child and converges the provisional turn to a terminal ownership state.",
    verdict: "The spawned pid is dead, the session is error, and no open or orphaned_spawn ownership remains after a retry interval.",
  }),
  F7: Object.freeze({
    injection: "Point a completion target at a missing node and repeatedly advance only its lab retry clock.",
    expectedOutcome: "The canonical 16-attempt budget ends in an explained dead letter; a live-target control delivery consumes exactly once.",
    verdict: "The failed delivery has 16 attempts and a reason, while the control relation has one consumption receipt.",
  }),
});

export function parseHarnessArguments(argv) {
  const [command, subject] = argv;
  if (command === "all") {
    rejectUnexpectedArguments(argv, 1);
    return { command: "all" };
  }
  // Proves every judge can still see a violation. Cheap, and the only reason
  // the fake `user_message_loss` invariant survived as long as it did is that
  // nothing like this existed to ask it.
  if (command === "mutation") {
    rejectUnexpectedArguments(argv, 1);
    return { command: "mutation" };
  }
  if (command === "scenario") {
    if (!Object.hasOwn(SCENARIO_DEFINITIONS, subject)) {
      throw new Error(`unknown scenario: ${subject ?? "<missing>"}`);
    }
    rejectUnexpectedArguments(argv, 2);
    return { command: "scenario", scenarioId: subject };
  }
  if (command === "cycle") {
    const concurrency = integerArgument(argv, "--concurrency", 1);
    const cycles = integerArgument(argv, "--cycles", 1);
    const intervalSeconds = integerArgument(argv, "--interval-seconds", 300, true);
    if (concurrency < 1 || concurrency > 2) {
      throw new Error("concurrency must be 1 or 2");
    }
    if (cycles < 1) throw new Error("cycles must be positive");
    if (intervalSeconds < 0) throw new Error("interval-seconds must be non-negative");
    rejectCycleUnknownArguments(argv);
    return { command: "cycle", concurrency, cycles, intervalSeconds };
  }
  throw new Error("usage: fault-harness.sh <cycle|scenario|all|mutation>");
}

export function toggleReleaseGeneration(text) {
  const key = "AUTH_BEARER_TOKEN_GENERATION";
  const pattern = new RegExp(`^${key}=(lab-fault-a|lab-fault-b)$`, "m");
  const match = text.match(pattern);
  if (!match) {
    const separator = text.endsWith("\n") ? "" : "\n";
    return {
      previous: null,
      next: "lab-fault-a",
      text: `${text}${separator}${key}=lab-fault-a\n`,
    };
  }
  const previous = match[1];
  const next = previous === "lab-fault-a" ? "lab-fault-b" : "lab-fault-a";
  return {
    previous,
    next,
    text: text.replace(pattern, `${key}=${next}`),
  };
}

export function buildInterventionPayload(deliveryId, text) {
  requireNonEmpty(deliveryId, "delivery id");
  requireNonEmpty(text, "intervention text");
  return {
    text,
    user: "lab-fault-harness",
    delivery_id: deliveryId,
    delivery_intent: "human_live_steer",
    source: "lab_fault_harness",
  };
}

export function autoResumeHandoffViolations({
  attempts,
  executionPromiseBlockedCount = 0,
  replacementLogCount = 0,
  socketErrorCount = 0,
}) {
  const violations = [];
  for (const [index, attempt] of attempts.entries()) {
    const attemptNumber = attempt.attemptNumber ?? index + 1;
    if (attempt.deliveryReceiptCount !== 1) {
      violations.push(`attempt ${attemptNumber} delivery receipt count ${attempt.deliveryReceiptCount}`);
    }
    if (attempt.consumptionCount !== 1) violations.push(`attempt ${attemptNumber} consumption count ${attempt.consumptionCount}`);
    if (attempt.userMessageCount !== 1) violations.push(`attempt ${attemptNumber} user message count ${attempt.userMessageCount}`);
    if (attempt.turnBoundaryCount !== 2) {
      violations.push(`attempt ${attemptNumber} turn boundary count ${attempt.turnBoundaryCount}`);
    }
    if (attempt.successfulTurnBoundaryCount !== 2) {
      violations.push(`attempt ${attemptNumber} successful turn boundary count ${attempt.successfulTurnBoundaryCount}`);
    }
    if (attempt.childTerminalStatus !== "completed") {
      violations.push(`attempt ${attemptNumber} child terminal status ${attempt.childTerminalStatus}`);
    }
    if (attempt.parentTerminalStatus !== "completed") {
      violations.push(`attempt ${attemptNumber} parent terminal status ${attempt.parentTerminalStatus}`);
    }
    if (attempt.observedPids.length !== 1 || attempt.observedPids[0] !== attempt.oldPid) {
      violations.push(`attempt ${attemptNumber} runner pid(s) ${attempt.observedPids.join(",")} != ${attempt.oldPid}`);
    }
  }
  if (executionPromiseBlockedCount !== 0) {
    violations.push(`${executionPromiseBlockedCount} execution_promise recovery block(s)`);
  }
  if (replacementLogCount !== 0) violations.push(`${replacementLogCount} replacement log(s)`);
  if (socketErrorCount !== 0) violations.push(`${socketErrorCount} runner socket error(s)`);
  return violations;
}

export function inPostTurnAutoResumeHandoffWindow(deltaMs) {
  return Number.isFinite(deltaMs) && deltaMs > 0 && deltaMs <= 1_000;
}

export function restartWindowContinuityViolations(observation) {
  const violations = [];
  if (
    observation.acceptance?.status !== "ok"
    || !["delivered", "queued", "auto_resumed"].includes(observation.acceptance?.outcome)
  ) {
    violations.push(`intervention was not accepted: ${JSON.stringify(observation.acceptance)}`);
  }
  if (observation.interventionCount !== 1) {
    violations.push(`intervention receipt count ${observation.interventionCount}`);
  }
  if (observation.oldAssistantCount !== 1) {
    violations.push(`old assistant marker count ${observation.oldAssistantCount}`);
  }
  if (observation.assistantCount !== 1) violations.push(`assistant marker count ${observation.assistantCount}`);
  if (observation.inboxRemainingCount !== 0) {
    violations.push(`${observation.inboxRemainingCount} intervention inbox row(s) remain`);
  }
  if (observation.inFlightCount !== 0) violations.push(`${observation.inFlightCount} in-flight ownership(s)`);
  if (observation.oldPid !== observation.newPid) {
    violations.push(`runner pid changed ${observation.oldPid} -> ${observation.newPid}`);
  }
  if (observation.oldReleaseManifestId !== observation.newReleaseManifestId) {
    violations.push("live runner provenance changed during host adoption");
  }
  if (observation.replacementLogCount !== 0) {
    violations.push(`${observation.replacementLogCount} replacement log(s)`);
  }
  return violations;
}

export function restartWindowDurableViolations(observation) {
  const violations = [];
  if (
    observation.acceptance?.status !== "ok"
    || !["delivered", "queued", "auto_resumed"].includes(observation.acceptance?.outcome)
  ) {
    violations.push(`intervention was not durably accepted: ${JSON.stringify(observation.acceptance)}`);
  }
  if (observation.deliveryCount !== 1) {
    violations.push(`durable delivery receipt count ${observation.deliveryCount}`);
  }
  if (
    observation.delivery?.state !== "consumed"
    || observation.delivery?.aggregate_state !== "consumed"
  ) {
    violations.push(
      `durable delivery remained ${observation.delivery?.state ?? "missing"}`
      + `/${observation.delivery?.aggregate_state ?? "missing"}`,
    );
  }
  if (!observation.delivery?.target_receipt_id) {
    violations.push("durable delivery has no target receipt");
  }
  if (observation.interventionCount !== 1) {
    violations.push(`intervention receipt count ${observation.interventionCount}`);
  }
  if (observation.assistantCount !== 1) {
    violations.push(`assistant marker count ${observation.assistantCount}`);
  }
  if (observation.inboxRemainingCount !== 0) {
    violations.push(`${observation.inboxRemainingCount} intervention inbox row(s) remain`);
  }
  if (observation.inFlightCount !== 0) {
    violations.push(`${observation.inFlightCount} in-flight ownership(s)`);
  }
  if (observation.sessionStatus !== "completed") {
    violations.push(`session status ${observation.sessionStatus}`);
  }
  if (observation.oldPid !== observation.newPid) {
    violations.push(`runner pid changed ${observation.oldPid} -> ${observation.newPid}`);
  }
  if (observation.oldReleaseManifestId !== observation.newReleaseManifestId) {
    violations.push("live runner provenance changed during restart-window delivery");
  }
  if (observation.replacementLogCount !== 0) {
    violations.push(`${observation.replacementLogCount} replacement log(s)`);
  }
  return violations;
}

export function buildDurableDeliverySeed(
  deliveryId,
  sessionId,
  text,
  leaseOwner,
  logicalMessageId,
) {
  requireNonEmpty(deliveryId, "delivery id");
  requireNonEmpty(sessionId, "session id");
  requireNonEmpty(text, "intervention text");
  const completionId = `message:${deliveryId}`;
  const relationKey = `user_message:${sessionId}:${deliveryId}`;
  const source = "lab_fault_harness";
  const user = "lab-fault-harness";
  const payload = {
    text,
    user,
    logical_message_id: logicalMessageId ?? deliveryId,
    attachment_paths: null,
    context: null,
    caller_info: null,
    followup_key: null,
    followup_attempt: null,
    followup_task_ids: null,
  };
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(canonicalize({
      ...payload,
      source,
      completion_id: completionId,
      relation_key: relationKey,
    })), "utf8")
    .digest("hex");
  return {
    deliveryId,
    sessionId,
    completionId,
    relationKey,
    source,
    payload,
    payloadHash,
    intervention: {
      text,
      user,
      source,
      delivery_id: deliveryId,
      delivery_intent: "durable_next_turn",
      completion_id: completionId,
      relation_key: relationKey,
      ...(leaseOwner ? { delivery_lease_owner: leaseOwner } : {}),
    },
  };
}

export function evaluateInvariantSnapshot(snapshot) {
  const violations = [];
  // Every invariant now names what it found. A violation that cannot be named
  // can only be compared by count, and counts cancel: an old one clearing as a
  // new one arrives reads as no change at all.
  const ownerless = asExamples(snapshot.ownerlessRunning);
  if (ownerless.length > 0) {
    violations.push(invariant("ownerless_running", ownerless.length, ownerless));
  }
  if (snapshot.terminalProjectionMismatches.length > 0) {
    violations.push(invariant(
      "runner_terminal_projection",
      snapshot.terminalProjectionMismatches.length,
      snapshot.terminalProjectionMismatches,
    ));
  }
  const overdueRetriesExamples = asExamples(snapshot.overdueRetries);
  if (overdueRetriesExamples.length > 0) {
    violations.push(invariant("overdue_retry", overdueRetriesExamples.length, overdueRetriesExamples));
  }
  const ambiguousUncertainExamples = asExamples(snapshot.ambiguousUncertain);
  if (ambiguousUncertainExamples.length > 0) {
    violations.push(invariant("ambiguous_uncertain", ambiguousUncertainExamples.length, ambiguousUncertainExamples));
  }
  const reasonlessDeadLettersExamples = asExamples(snapshot.reasonlessDeadLetters);
  if (reasonlessDeadLettersExamples.length > 0) {
    violations.push(invariant("reasonless_dead_letter", reasonlessDeadLettersExamples.length, reasonlessDeadLettersExamples));
  }
  if (snapshot.activationManifestMismatch) {
    violations.push(invariant("activation_manifest", 1));
  }
  // The user-facing invariant: every input got a reply or a visible failure.
  //
  // It replaces two entries. `user_message_loss` read a parameter every caller
  // set to `[]`, so it was incapable of firing. `unanswered_user_input`
  // compared the newest input id against the newest reply id, so one reply
  // cleared every input at once and it could not see `intervention_sent` at
  // all. Both are deleted rather than kept alongside: a judge left in place
  // after it is known not to work is a judge the next reader will believe.
  const unanswered = snapshot.unansweredDemands ?? [];
  if (unanswered.length > 0) {
    violations.push(invariant("unanswered_demand", unanswered.length, unanswered));
  }
  return violations;
}

/**
 * The violations present after a scenario that were not present before it.
 *
 * Identity, not arithmetic. Comparing counts hid a real failure whenever an
 * old violation cleared while a new one appeared: the delta came out zero and
 * the run passed while a session it had just broken sat in the list. Where a
 * violation carries examples, each example is matched by its own identity;
 * only count-only violations, which name nothing to match, still fall back to
 * the difference in counts.
 */
/** Tolerates the old count-shaped snapshots so a stored sample still reads. */
function asExamples(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "number" && value > 0) {
    return Array.from({ length: value }, (_, index) => ({ unnamed: index }));
  }
  return [];
}

export function newInvariantViolations(before, after) {
  const baseline = new Map(before.map((violation) => [violation.invariant, violation]));
  return after.flatMap((violation) => {
    const previous = baseline.get(violation.invariant);
    const examples = violation.examples ?? [];
    if (examples.length === 0) {
      const delta = violation.count - (previous?.count ?? 0);
      return delta > 0 ? [{ ...violation, count: delta, examples: [] }] : [];
    }
    const previousExamples = new Set((previous?.examples ?? []).map(stableExampleKey));
    const fresh = examples.filter(
      (example) => !previousExamples.has(stableExampleKey(example)),
    );
    return fresh.length > 0 ? [{ ...violation, count: fresh.length, examples: fresh }] : [];
  });
}

export function redactEvidenceLine(line, secrets = []) {
  let redacted = String(line)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1<redacted>")
    .replace(/(password|token|secret)(\s*[:=]\s*)[^\s,"']+/gi, "$1$2<redacted>");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    redacted = redacted.replaceAll(secret, "<redacted>");
  }
  return redacted;
}

export function countMatchingTimelineEvents(timeline, eventType, text) {
  return (timeline.messages ?? []).filter(
    (message) => message.event_type === eventType
      && JSON.stringify(message.payload ?? {}).includes(text),
  ).length;
}

function invariant(name, count, examples = []) {
  return { invariant: name, count, examples };
}

function stableExampleKey(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => (
    left.localeCompare(right)
  ))));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function integerArgument(argv, name, fallback, allowZero = false) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = argv[index + 1];
  if (!/^\d+$/.test(raw ?? "")) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (!allowZero && value === 0)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return value;
}

function rejectUnexpectedArguments(argv, expectedLength) {
  if (argv.length !== expectedLength) throw new Error("unexpected arguments");
}

function rejectCycleUnknownArguments(argv) {
  const known = new Set(["--concurrency", "--cycles", "--interval-seconds"]);
  for (let index = 1; index < argv.length; index += 2) {
    if (!known.has(argv[index]) || argv[index + 1] === undefined) {
      throw new Error(`unknown or incomplete argument: ${argv[index] ?? "<missing>"}`);
    }
  }
}

function requireNonEmpty(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}
