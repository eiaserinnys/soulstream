import type {
  EngineInterventionResult,
  EngineInterventionMechanism,
} from "../engine/protocol.js";

export function normalizeRunnerInterventionResult(
  result: unknown,
): EngineInterventionResult {
  if (
    isRecord(result)
    && result.status === "delivered"
    && isInterventionMechanism(result.mechanism)
  ) {
    return { status: "delivered", mechanism: result.mechanism };
  }
  if (
    isRecord(result)
    && result.status === "not_delivered"
    && isInterventionMechanism(result.mechanism)
    && isInterventionFailureReason(result.reason)
  ) {
    return {
      status: "not_delivered",
      mechanism: result.mechanism,
      reason: result.reason,
      ...(typeof result.message === "string" ? { message: result.message } : {}),
    };
  }
  if (isRecord(result) && result.status === "not_supported") {
    return {
      status: "not_delivered",
      mechanism: "unsupported",
      reason: "not_supported",
      message: "Runner child does not expose the intervention operation",
    };
  }
  if (isRecord(result) && result.status === "unknown") {
    return {
      status: "unknown",
      reason: "verdict_unknown",
      ...(typeof result.message === "string" ? { message: result.message } : {}),
    };
  }
  return {
    status: "unknown",
    reason: "verdict_unknown",
    message: "Runner child returned an invalid intervention result",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInterventionMechanism(
  value: unknown,
): value is EngineInterventionMechanism {
  return value === "active_turn"
    || value === "interrupt_then_next_turn"
    || value === "unsupported";
}

function isInterventionFailureReason(
  value: unknown,
): value is Extract<EngineInterventionResult, { status: "not_delivered" }>["reason"] {
  return value === "not_supported"
    || value === "no_active_turn"
    || value === "not_accepting_input"
    || value === "turn_mismatch"
    || value === "failed"
    || value === "next_turn_required";
}
