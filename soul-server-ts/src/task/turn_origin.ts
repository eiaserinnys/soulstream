import type { TurnOrigin, TurnOriginKind } from "../engine/protocol.js";
import type { InterventionMessage } from "./task_models.js";

const RUNTIME_FOLLOWUP_SOURCE = "claude_runtime_task_followup";

export function interventionTurnOrigin(
  message: InterventionMessage,
  inputUuid?: string,
): TurnOrigin {
  return {
    kind: interventionTurnOriginKind(message),
    ...(firstNonEmpty(
      message.deliveryId,
      message.runnerInterventionId,
      message.callerTurnId,
      inputUuid,
    ) !== undefined
      ? {
          id: firstNonEmpty(
            message.deliveryId,
            message.runnerInterventionId,
            message.callerTurnId,
            inputUuid,
          ),
        }
      : {}),
  };
}

export function interventionTurnOriginKind(
  message: Pick<InterventionMessage, "deliveryIntent" | "source">,
): TurnOriginKind {
  if (message.deliveryIntent === "durable_next_turn") return "durable_next_turn";
  if (message.deliveryIntent === "completion_notification") {
    return "completion_notification";
  }
  if (
    message.deliveryIntent === "runtime_followup"
    || message.source === RUNTIME_FOLLOWUP_SOURCE
  ) {
    return "runtime_followup";
  }
  return "user_message";
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}
