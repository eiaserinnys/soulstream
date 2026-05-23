import { describe, expect, it } from "vitest";

import {
  buildRespondAck,
  buildToolApprovalAck,
} from "../../src/upstream/delivery_ack.js";

describe("delivery ACK transformers", () => {
  it("builds respond ok ACK with command and input request ids separated", () => {
    expect(
      buildRespondAck({
        requestId: "orch-cmd-1",
        inputRequestId: "ask-hex-1",
        result: {
          status: "delivered",
          requestId: "ask-hex-1",
          eventId: 42,
        },
      }),
    ).toEqual({
      type: "respond_ack",
      requestId: "orch-cmd-1",
      inputRequestId: "ask-hex-1",
      status: "ok",
      delivered: true,
      eventId: 42,
    });
  });

  it("maps respond failures to stable ACK codes and default messages", () => {
    expect(
      buildRespondAck({
        requestId: "orch-cmd-1",
        inputRequestId: "ask-expired",
        result: { status: "expired", requestId: "ask-expired" },
      }),
    ).toEqual({
      type: "respond_ack",
      requestId: "orch-cmd-1",
      inputRequestId: "ask-expired",
      status: "error",
      code: "INPUT_REQUEST_EXPIRED",
      message: "Input request expired: ask-expired",
    });

    expect(
      buildRespondAck({
        requestId: "orch-cmd-2",
        inputRequestId: "ask-unsupported",
        result: {
          status: "not_supported",
          requestId: "ask-unsupported",
          backend: "codex",
        },
      }),
    ).toEqual({
      type: "respond_ack",
      requestId: "orch-cmd-2",
      inputRequestId: "ask-unsupported",
      status: "error",
      code: "INPUT_RESPONSE_NOT_SUPPORTED",
      message: "Input response is not supported by backend: codex",
      backend: "codex",
    });
  });

  it("preserves delivery result messages and task status in respond error ACKs", () => {
    expect(
      buildRespondAck({
        requestId: "orch-cmd-3",
        inputRequestId: "ask-running",
        result: {
          status: "session_not_running",
          requestId: "ask-running",
          message: "task finished while answering",
          taskStatus: "completed",
        },
      }),
    ).toEqual({
      type: "respond_ack",
      requestId: "orch-cmd-3",
      inputRequestId: "ask-running",
      status: "error",
      code: "SESSION_NOT_RUNNING",
      message: "task finished while answering",
      taskStatus: "completed",
    });
  });

  it("builds tool approval ok ACK with decision and event id", () => {
    expect(
      buildToolApprovalAck({
        requestId: "orch-approval-1",
        approvalId: "danger-call-1",
        decision: "rejected",
        result: {
          status: "delivered",
          approvalId: "danger-call-1",
          decision: "rejected",
          eventId: 77,
        },
      }),
    ).toEqual({
      type: "tool_approval_ack",
      requestId: "orch-approval-1",
      approvalId: "danger-call-1",
      decision: "rejected",
      status: "ok",
      delivered: true,
      eventId: 77,
    });
  });

  it("maps tool approval failures to stable ACK codes and default messages", () => {
    expect(
      buildToolApprovalAck({
        requestId: "orch-approval-2",
        approvalId: "danger-call-2",
        decision: "approved",
        result: {
          status: "approval_not_pending",
          approvalId: "danger-call-2",
          decision: "approved",
        },
      }),
    ).toEqual({
      type: "tool_approval_ack",
      requestId: "orch-approval-2",
      approvalId: "danger-call-2",
      decision: "approved",
      status: "error",
      code: "TOOL_APPROVAL_NOT_PENDING",
      message: "Tool approval not pending: danger-call-2",
    });

    expect(
      buildToolApprovalAck({
        requestId: "orch-approval-3",
        approvalId: "danger-call-3",
        decision: "rejected",
        result: {
          status: "not_supported",
          approvalId: "danger-call-3",
          decision: "rejected",
          backend: "claude",
        },
      }),
    ).toEqual({
      type: "tool_approval_ack",
      requestId: "orch-approval-3",
      approvalId: "danger-call-3",
      decision: "rejected",
      status: "error",
      code: "TOOL_APPROVAL_NOT_SUPPORTED",
      message: "Tool approval is not supported by backend: claude",
      backend: "claude",
    });
  });
});
