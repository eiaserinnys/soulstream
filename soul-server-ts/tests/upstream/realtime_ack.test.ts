import { describe, expect, it } from "vitest";

import {
  buildRealtimeAckError,
  buildRealtimeCallCreatedAck,
  buildRealtimeEventAck,
  buildRealtimeToolApprovalAck,
} from "../../src/upstream/realtime_ack.js";

describe("realtime ACK transformers", () => {
  it("builds realtime call-created ACKs from broker results", () => {
    expect(
      buildRealtimeCallCreatedAck({
        requestId: "rt-create-1",
        agentSessionId: "sess-rt",
        result: {
          status: "ok",
          agentSessionId: "sess-rt",
          callId: "call_1",
          answerSdp: "answer-sdp",
          eventId: 55,
        },
      }),
    ).toEqual({
      type: "realtime_call_created",
      requestId: "rt-create-1",
      agentSessionId: "sess-rt",
      status: "ok",
      callId: "call_1",
      answerSdp: "answer-sdp",
      eventId: 55,
    });
  });

  it("builds realtime event ACKs with optional normalized type and event id", () => {
    expect(
      buildRealtimeEventAck({
        requestId: "rt-event-1",
        agentSessionId: "sess-rt",
        result: {
          status: "ok",
          agentSessionId: "sess-rt",
          normalizedType: "realtime_transcript",
          eventId: 56,
        },
      }),
    ).toEqual({
      type: "realtime_event_ack",
      requestId: "rt-event-1",
      agentSessionId: "sess-rt",
      status: "ok",
      normalizedType: "realtime_transcript",
      eventId: 56,
    });

    expect(
      buildRealtimeEventAck({
        requestId: "rt-event-2",
        agentSessionId: "sess-rt",
        result: {
          status: "ok",
          agentSessionId: "sess-rt",
        },
      }),
    ).toEqual({
      type: "realtime_event_ack",
      requestId: "rt-event-2",
      agentSessionId: "sess-rt",
      status: "ok",
    });
  });

  it("builds realtime tool approval ACKs with data-channel event payloads", () => {
    expect(
      buildRealtimeToolApprovalAck({
        requestId: "rt-approval-1",
        agentSessionId: "sess-rt",
        approvalId: "approval-1",
        decision: "rejected",
        result: {
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
        },
      }),
    ).toEqual({
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

  it("builds stable realtime error ACKs without broker-domain status mapping", () => {
    expect(
      buildRealtimeAckError({
        type: "realtime_tool_approval_ack",
        requestId: "rt-approval-2",
        agentSessionId: "sess-rt",
        message: "no call",
      }),
    ).toEqual({
      type: "realtime_tool_approval_ack",
      requestId: "rt-approval-2",
      agentSessionId: "sess-rt",
      status: "error",
      code: "REALTIME_ERROR",
      message: "no call",
    });
  });
});
