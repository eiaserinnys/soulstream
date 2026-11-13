import type { Logger } from "pino";

import type { SessionDeliveryRow } from "../db/session_db_types.js";
import type { NodeInstructionVerdict } from "./state/node_instruction_decision.js";
import type { Task } from "./task_models.js";

/**
 * Asks the runner this task is attached to whether it received an instruction
 * number. "Unknown" covers every case where the answer cannot prove anything:
 * no runner, a dispatcher that cannot look up receipts, a replaced
 * registration, an old runner that does not know the command, or a failed
 * lookup. Only a runner of the same registration that says it never received
 * the number yields "not_applied".
 */
export async function askRunnerInstructionReceipt(
  task: Pick<Task, "runner" | "agentSessionId">,
  instructionNumber: string,
  expectedRegistrationId: string | undefined,
  logger?: Pick<Logger, "warn">,
): Promise<NodeInstructionVerdict> {
  const dispatcher = task.runner?.dispatcher;
  if (!dispatcher?.lookupInterventionReceipt || !expectedRegistrationId) return "unknown";
  try {
    return await dispatcher.lookupInterventionReceipt(
      instructionNumber,
      expectedRegistrationId,
    );
  } catch (err) {
    logger?.warn(
      { err, sessionId: task.agentSessionId, instructionNumber },
      "intervention receipt lookup failed; treating the instruction as unknown",
    );
    return "unknown";
  }
}

/**
 * The registration the runner was running under when an instruction is handed
 * over. Read it before the handoff: a runner replaced afterwards must not be
 * mistaken for the one that received the instruction.
 */
export function handoffRegistrationId(
  task: Pick<Task, "runner" | "executionRegistration">,
): string | undefined {
  return task.runner?.dispatcher.registrationId?.()
    ?? task.executionRegistration?.registrationId;
}

/**
 * Startup recovery's lookup. The ledger row's delivery id is the instruction
 * number. A session the node holds no runner for cannot answer, so it is unknown.
 */
export function createInstructionReceiptLookup(
  getTask: (sessionId: string) => Task | undefined,
  logger?: Pick<Logger, "warn">,
): (row: SessionDeliveryRow) => Promise<NodeInstructionVerdict> {
  return async (row) => {
    const task = row.target_session_id ? getTask(row.target_session_id) : undefined;
    if (!task) return "unknown";
    return await askRunnerInstructionReceipt(
      task,
      row.delivery_id,
      handoffRegistrationId(task),
      logger,
    );
  };
}
