import { describe, expect, it, vi } from "vitest";

import type { RealtimeBroker } from "../../src/realtime/realtime_broker.js";
import {
  RealtimeCommandError,
  RealtimeCommands,
} from "../../src/upstream/realtime_commands.js";

function createRealtimeCommands(opts: {
  createCall?: RealtimeBroker["createCall"];
  relayEvent?: RealtimeBroker["relayEvent"];
  resolveToolApproval?: RealtimeBroker["resolveToolApproval"];
} = {}) {
  const broker = {
    createCall:
      opts.createCall ??
      vi.fn(async () => ({
        status: "ok",
        agentSessionId: "sess-rt",
        callId: "call_1",
        answerSdp: "answer-sdp",
        eventId: 55,
      })),
    relayEvent:
      opts.relayEvent ??
      vi.fn(async () => ({
        status: "ok",
        agentSessionId: "sess-rt",
        normalizedType: "realtime_transcript",
        eventId: 56,
      })),
    resolveToolApproval:
      opts.resolveToolApproval ??
      vi.fn(async () => ({
        status: "ok",
        agentSessionId: "sess-rt",
        approvalId: "approval-1",
        decision: "approved",
        eventId: 57,
        dataChannelEvent: {
          type: "tool_approval.response",
          approval_id: "approval-1",
          decision: "approved",
        },
      })),
  } as Pick<RealtimeBroker, "createCall" | "relayEvent" | "resolveToolApproval">;

  return { commands: new RealtimeCommands(broker), broker };
}

describe("RealtimeCommands.createCall", () => {
  it("normalizes session and offer ids, calls broker, and returns call-created ACK", async () => {
    const createCall = vi.fn().mockResolvedValue({
      status: "ok",
      agentSessionId: "sess-rt",
      callId: "call_1",
      answerSdp: "answer-sdp",
      eventId: 55,
    });
    const { commands, broker } = createRealtimeCommands({ createCall });

    const ack = await commands.createCall({
      type: "realtime_create_call",
      session_id: "sess-rt",
      offer_sdp: "offer-sdp",
      request_id: "rt-create-1",
      model: "gpt-realtime",
      voice: "alloy",
      instructions: null,
    });

    expect(broker.createCall).toHaveBeenCalledWith({
      agentSessionId: "sess-rt",
      offerSdp: "offer-sdp",
      model: "gpt-realtime",
      voice: "alloy",
      instructions: null,
    });
    expect(ack).toEqual({
      type: "realtime_call_created",
      requestId: "rt-create-1",
      agentSessionId: "sess-rt",
      status: "ok",
      callId: "call_1",
      answerSdp: "answer-sdp",
      eventId: 55,
    });
  });

  it("rejects invalid create-call commands before broker calls", async () => {
    const createCall = vi.fn();
    const { commands } = createRealtimeCommands({ createCall });

    await expect(
      commands.createCall({
        type: "realtime_create_call",
        agentSessionId: "sess-rt",
        requestId: "rt-create-2",
      }),
    ).rejects.toMatchObject({
      ackType: "realtime_call_created",
      requestId: "rt-create-2",
      agentSessionId: "sess-rt",
    });
    expect(createCall).not.toHaveBeenCalled();
  });

  it("calls broker but returns null when command requestId is absent", async () => {
    const { commands, broker } = createRealtimeCommands();

    const ack = await commands.createCall({
      type: "realtime_create_call",
      agentSessionId: "sess-rt",
      offerSdp: "offer-sdp",
    });

    expect(broker.createCall).toHaveBeenCalledWith({
      agentSessionId: "sess-rt",
      offerSdp: "offer-sdp",
    });
    expect(ack).toBeNull();
  });
});

describe("RealtimeCommands.relayEvent", () => {
  it("forwards null event values and normalized call ids to broker", async () => {
    const relayEvent = vi.fn().mockResolvedValue({
      status: "ok",
      agentSessionId: "sess-rt",
    });
    const { commands, broker } = createRealtimeCommands({ relayEvent });

    const ack = await commands.relayEvent({
      type: "realtime_event",
      agentSessionId: "sess-rt",
      event: null,
      call_id: "call_1",
      requestId: "rt-event-1",
    });

    expect(broker.relayEvent).toHaveBeenCalledWith({
      agentSessionId: "sess-rt",
      event: null,
      callId: "call_1",
    });
    expect(ack).toEqual({
      type: "realtime_event_ack",
      requestId: "rt-event-1",
      agentSessionId: "sess-rt",
      status: "ok",
    });
  });

  it("rejects undefined events before broker calls", async () => {
    const relayEvent = vi.fn();
    const { commands } = createRealtimeCommands({ relayEvent });

    await expect(
      commands.relayEvent({
        type: "realtime_event",
        agentSessionId: "sess-rt",
        requestId: "rt-event-2",
      }),
    ).rejects.toBeInstanceOf(RealtimeCommandError);
    expect(relayEvent).not.toHaveBeenCalled();
  });
});

describe("RealtimeCommands.resolveToolApproval", () => {
  it("normalizes approval fields, forwards source metadata, and returns approval ACK", async () => {
    const resolveToolApproval = vi.fn().mockResolvedValue({
      status: "ok",
      agentSessionId: "sess-rt",
      approvalId: "approval-1",
      decision: "rejected",
      eventId: 57,
      dataChannelEvent: {
        type: "tool_approval.response",
        approval_id: "approval-1",
        decision: "rejected",
        message: "no",
      },
    });
    const { commands, broker } = createRealtimeCommands({ resolveToolApproval });

    const ack = await commands.resolveToolApproval({
      type: "realtime_resolve_tool_approval",
      session_id: "sess-rt",
      approval_id: "approval-1",
      decision: "rejected",
      message: "no",
      source: "voice",
      call_id: "call_1",
      request_id: "rt-approval-1",
    });

    expect(broker.resolveToolApproval).toHaveBeenCalledWith({
      agentSessionId: "sess-rt",
      approvalId: "approval-1",
      decision: "rejected",
      message: "no",
      source: "voice",
      callId: "call_1",
    });
    expect(ack).toEqual({
      type: "realtime_tool_approval_ack",
      requestId: "rt-approval-1",
      agentSessionId: "sess-rt",
      approvalId: "approval-1",
      decision: "rejected",
      status: "ok",
      dataChannelEvent: {
        type: "tool_approval.response",
        approval_id: "approval-1",
        decision: "rejected",
        message: "no",
      },
      eventId: 57,
    });
  });

  it("maps broker failures to realtime command errors with ACK metadata", async () => {
    const { commands } = createRealtimeCommands({
      resolveToolApproval: vi.fn().mockRejectedValue(new Error("no call")),
    });

    await expect(
      commands.resolveToolApproval({
        type: "realtime_resolve_tool_approval",
        agentSessionId: "sess-rt",
        approvalId: "approval-1",
        decision: "approved",
        requestId: "rt-approval-2",
      }),
    ).rejects.toMatchObject({
      ackType: "realtime_tool_approval_ack",
      requestId: "rt-approval-2",
      agentSessionId: "sess-rt",
      message: "no call",
    });
  });

  it("returns configured realtime ACK metadata when broker is missing", async () => {
    const commands = new RealtimeCommands(undefined);

    await expect(
      commands.resolveToolApproval({
        type: "realtime_resolve_tool_approval",
        agentSessionId: "sess-rt",
        approvalId: "approval-1",
        decision: "approved",
        requestId: "rt-approval-3",
      }),
    ).rejects.toMatchObject({
      ackType: "realtime_tool_approval_ack",
      requestId: "rt-approval-3",
      agentSessionId: "sess-rt",
      message: "Realtime broker is not configured in soul-server-ts",
    });
  });
});
