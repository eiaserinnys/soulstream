import { describe, expect, it, vi } from "vitest";
import { parsePersistentInstructionsApplyPayload } from
  "@soulstream/wire-schema/persistent-session-instructions";

import type { SessionActionCommandDispatchOptions } from
  "../src/session/session_action_command_errors.js";
import { createPersistentInstructionCommandSender } from
  "../src/turn-summary/live_turn_summary_pipeline.js";

describe("persistent instruction command sender", () => {
  it("routes the H1 body in the settings command envelope", async () => {
    const routedCommand = { command: { message: {} }, node: { nodeId: "node-a" } };
    const routeExistingSessionPendingCommand = vi.fn()
      .mockResolvedValue(routedCommand);
    const sendPendingCommand = vi.fn().mockResolvedValue({
      type: "persistent_session_instructions_applied",
    });
    const sender = createPersistentInstructionCommandSender({
      router: { routeExistingSessionPendingCommand } as unknown as
        SessionActionCommandDispatchOptions["router"],
      bridge: { sendPendingCommand } as unknown as
        SessionActionCommandDispatchOptions["bridge"],
      timeoutMs: 4321,
    });

    await sender({
      session_id: "session-a",
      origin: "extracted",
      ops: [{
        op: "add",
        text: "앞으로 응답은 간결하게 써 줘.",
        source_turns: ["T5"],
        source_event_ids: [10],
      }],
      anchor: "input-10",
    });

    const outgoingPayload = routeExistingSessionPendingCommand.mock.calls[0]?.[0];
    expect(outgoingPayload).toEqual({
      type: "apply_persistent_session_instructions",
      agentSessionId: "session-a",
      origin: "extracted",
      ops: [{
        op: "add",
        text: "앞으로 응답은 간결하게 써 줘.",
        source_turns: ["T5"],
        source_event_ids: [10],
      }],
      anchor: "input-10",
    });
    expect(outgoingPayload).not.toHaveProperty("session_id");
    expect(routeExistingSessionPendingCommand).toHaveBeenCalledWith(
      outgoingPayload,
      { timeoutMs: 4321 },
    );
    expect(parsePersistentInstructionsApplyPayload({
      session_id: outgoingPayload.agentSessionId,
      origin: outgoingPayload.origin,
      ops: outgoingPayload.ops,
      ...(outgoingPayload.anchor === undefined
        ? {}
        : { anchor: outgoingPayload.anchor }),
    })).toMatchObject({ ok: true });
    expect(sendPendingCommand).toHaveBeenCalledWith(routedCommand);
  });
});
