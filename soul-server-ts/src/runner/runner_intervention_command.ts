import type { SSEEventPayload } from "../engine/protocol.js";

import {
  runnerCommandResultFrame,
  type RunnerCommandFrame,
  type RunnerCommandResultFrame,
} from "./frame_protocol.js";
import { buildDurableRunnerEvent } from "./runner_child_runtime_helpers.js";
import type { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";

export async function handleRunnerInterventionCommand(
  command: RunnerCommandFrame,
  outbox: RunnerSqliteEventOutbox,
  sessionId: string,
): Promise<{
  result: RunnerCommandResultFrame;
  eventSourceSeq: number | null;
} | null> {
  if (command.kind !== "stage_intervention") return null;
  try {
    const event = command.event
      ? buildDurableRunnerEvent(
          sessionId,
          command.event as SSEEventPayload,
        ).appendInput
      : undefined;
    const staged = await outbox.stageIntervention({
      interventionId: command.interventionId,
      message: command.message,
      event,
      queued: command.queued,
      queuedAt: new Date().toISOString(),
    });
    return {
      result: runnerCommandResultFrame(command.commandId, {
        status: "ok",
        data: staged,
      }),
      eventSourceSeq: staged.eventSourceSeq,
    };
  } catch (error) {
    return {
      result: runnerCommandResultFrame(command.commandId, {
        status: "error",
        error: {
          code: "stage_intervention_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
      eventSourceSeq: null,
    };
  }
}

export async function claimRunnerInterventionExecution(
  command: Extract<RunnerCommandFrame, { kind: "execute" }>,
  outbox: RunnerSqliteEventOutbox,
): Promise<RunnerCommandResultFrame | null> {
  const interventionId = command.params.runnerInterventionId;
  if (!interventionId) return null;
  if (await outbox.claimIntervention(interventionId, command.commandId)) return null;
  return runnerCommandResultFrame(command.commandId, {
    status: "error",
    error: {
      code: "execute_intervention_claim_failed",
      message: `runner intervention unavailable: ${interventionId}`,
    },
  });
}

export async function finishRunnerInterventionExecution(
  command: Extract<RunnerCommandFrame, { kind: "execute" }>,
  outbox: RunnerSqliteEventOutbox,
  failed: boolean,
): Promise<void> {
  const interventionId = command.params.runnerInterventionId;
  if (failed && interventionId) {
    await outbox.releaseInterventionClaim(interventionId, command.commandId);
    return;
  }
  await outbox.completeInterventionClaim(command.commandId);
}
