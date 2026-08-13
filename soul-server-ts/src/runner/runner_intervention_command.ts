import type { SSEEventPayload } from "../engine/protocol.js";

import {
  runnerCommandResultFrame,
  type RunnerCommandFrame,
  type RunnerCommandResultFrame,
} from "./frame_protocol.js";
import { buildDurableRunnerEvent } from "./runner_child_runtime_helpers.js";
import { normalizeRunnerInterventionResult } from "./runner_intervention_result.js";
import type { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";

export async function handleRunnerInterventionCommand(
  command: RunnerCommandFrame,
  outbox: RunnerSqliteEventOutbox,
  sessionId: string,
  applyIntervention: (input: Record<string, unknown>) => Promise<unknown>,
): Promise<{
  result: RunnerCommandResultFrame;
  eventSourceSeq: number | null;
} | null> {
  if (
    command.kind === "invoke"
    && command.capability === "runner.apply_intervention"
  ) {
    return await applyRunnerIntervention(
      command,
      outbox,
      applyIntervention,
    );
  }
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

async function applyRunnerIntervention(
  command: Extract<RunnerCommandFrame, { kind: "invoke" }>,
  outbox: RunnerSqliteEventOutbox,
  applyIntervention: (input: Record<string, unknown>) => Promise<unknown>,
): Promise<{
  result: RunnerCommandResultFrame;
  eventSourceSeq: null;
}> {
  try {
    const [interventionId, interventionInput] = command.args;
    if (typeof interventionId !== "string" || interventionId.length === 0) {
      throw new Error("runner intervention id is required");
    }
    if (!isRecord(interventionInput) || typeof interventionInput.prompt !== "string") {
      throw new Error("runner intervention input is invalid");
    }
    const claimed = await outbox.claimIntervention(
      interventionId,
      command.commandId,
    );
    if (!claimed) {
      return {
        result: runnerCommandResultFrame(command.commandId, {
          status: "ok",
          data: {
            status: "not_delivered",
            mechanism: "unsupported",
            reason: "failed",
            message: `runner intervention unavailable: ${interventionId}`,
          },
        }),
        eventSourceSeq: null,
      };
    }

    // The durable row becomes a replay fence before the engine call. If the
    // host deadline wins, recovery sees ambiguous rather than replayable
    // pending state and cannot apply the same user intent twice.
    await outbox.markInterventionAmbiguous(
      interventionId,
      command.commandId,
    );

    let verdict;
    try {
      verdict = normalizeRunnerInterventionResult(
        await applyIntervention(interventionInput),
      );
    } catch (error) {
      verdict = {
        status: "unknown" as const,
        reason: "verdict_unknown" as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (verdict.status === "delivered") {
      await outbox.resolveAmbiguousIntervention(interventionId, "applied");
    }
    return {
      result: runnerCommandResultFrame(command.commandId, {
        status: "ok",
        data: verdict,
      }),
      eventSourceSeq: null,
    };
  } catch (error) {
    return {
      result: runnerCommandResultFrame(command.commandId, {
        status: "error",
        error: {
          code: "apply_intervention_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
      eventSourceSeq: null,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
