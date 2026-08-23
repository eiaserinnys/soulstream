export const SCENARIO_DEFINITIONS = Object.freeze({
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
    expectedOutcome: "The host rejects adoption, the detached old runner finishes, offline replay converges, and the next turn uses a new runner.",
    verdict: "At least one adoption mismatch log exists, both turn markers appear, and the runner pid and manifest change.",
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
