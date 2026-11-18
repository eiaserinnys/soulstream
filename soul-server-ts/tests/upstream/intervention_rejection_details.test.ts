import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { NodeResponseRejectedError, judgeNodeResponse } from "../../src/task/state/node_response_handling.js";
import { CommandDispatchError } from "../../src/upstream/command_family.js";
import { createInterventionCommandFamily } from "../../src/upstream/intervention_command_family.js";
import { TaskRuntimeCommands } from "../../src/upstream/task_runtime_commands.js";

function interveneWith(error: Error) {
  const runtime = new TaskRuntimeCommands({
    agentRegistry: { get: vi.fn() },
    taskManager: { addIntervention: vi.fn().mockRejectedValue(error) } as never,
    taskExecutor: { startNewExecution: vi.fn() } as never,
    logger: pino({ level: "silent" }),
  });
  const handlers = createInterventionCommandFamily({
    send: vi.fn(), deliveryCommands: {} as never, taskRuntimeCommands: runtime,
  });
  return handlers.intervene!({ type: "intervene", agentSessionId: "session-1", text: "continue" } as never);
}

describe("intervention rejection details", () => {
  it("forwards the resume verdict facts and decision to the command response", async () => {
    const verdict = judgeNodeResponse({
      call: "resume", route: "applied_false", reason: "worktree_not_ready",
      registration: "same", termination: "absent", centralSession: "present", retained: false,
    });
    const error = await interveneWith(new NodeResponseRejectedError(verdict, "resume rejected")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandDispatchError);
    expect(error).toMatchObject({
      message: "resume rejected", code: "NODE_RESPONSE_REJECTED",
      details: { reason: "worktree_not_ready", cell: "retryable", intents: ["retry_later"] },
    });
  });

  it("keeps ordinary errors as message-only command errors", async () => {
    const error = await interveneWith(new Error("resume failed")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandDispatchError);
    expect(error).toMatchObject({ message: "resume failed", code: undefined, details: undefined });
  });
});
