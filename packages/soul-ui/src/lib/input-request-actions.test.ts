import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";
import { createProcessingContext } from "../stores/processing-context";
import { submitInputResponse, submitToolApproval } from "./input-request-actions";

function detailResponse(ok: boolean, status: number, body = "") {
  return { ok, status, text: async () => body };
}

describe("submitToolApproval", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("성공하면 sent로 끝난다", async () => {
    fetchMock.mockResolvedValueOnce(detailResponse(true, 200));
    const result = await submitToolApproval("session-1", "approval-1", "node-1", "approved");
    expect(result).toEqual({ sent: true });
    expect(fetchMock.mock.calls[0][0])
      .toBe("/api/sessions/session-1/tool-approvals/approval-1/approve");
  });

  it("이미 처리된 노드는 already_resolved로 구분한다", async () => {
    const ctx = createProcessingContext();
    ctx.nodeMap.set("node-1", {
      id: "node-1",
      type: "tool_approval",
      approvalId: "approval-1",
      toolName: "Read",
      content: "",
      completed: true,
      resolved: true,
      children: [],
    } as never);
    useDashboardStore.setState({ processingCtx: ctx });

    const result = await submitToolApproval("session-1", "approval-1", "node-1", "approved");

    expect(result).toEqual({ sent: false, reason: "already_resolved" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("실패 응답은 상태와 본문을 담아 failed로 구분한다", async () => {
    fetchMock.mockResolvedValueOnce(detailResponse(
      false,
      503,
      JSON.stringify({ error: { code: "NODE_UNAVAILABLE" } }),
    ));

    const result = await submitToolApproval("session-1", "approval-1", "node-1", "rejected");

    expect(result).toMatchObject({ sent: false, reason: "failed", status: 503 });
    expect(result).toHaveProperty("body", JSON.stringify({ error: { code: "NODE_UNAVAILABLE" } }));
  });

  it("망 예외는 상태 없이 failed로 구분한다", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await submitToolApproval("session-1", "approval-1", "node-1", "approved");

    expect(result).toEqual({ sent: false, reason: "failed" });
  });
});

describe("submitInputResponse", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function markNodeResponded() {
    const ctx = createProcessingContext();
    ctx.nodeMap.set("node-1", {
      id: "node-1",
      type: "input_request",
      requestId: "request-1",
      questions: [],
      content: "",
      completed: true,
      responded: true,
      children: [],
    } as never);
    useDashboardStore.setState({ processingCtx: ctx });
  }

  it("로컬에서 이미 응답된 요청은 already_resolved로 끝난다", async () => {
    markNodeResponded();

    const result = await submitInputResponse("session-1", "request-1", "node-1", "질문", "답");

    expect(result).toEqual({ sent: false, reason: "already_resolved" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "INPUT_REQUEST_ALREADY_RESPONDED",
    "REQUEST_NOT_PENDING",
    "INPUT_REQUEST_EXPIRED",
  ])("422 %s는 already_resolved로 구분한다", async (code) => {
    fetchMock.mockResolvedValueOnce(detailResponse(
      false,
      422,
      JSON.stringify({ error: { code } }),
    ));

    const result = await submitInputResponse("session-1", "request-1", "node-1", "질문", "답");

    expect(result).toEqual({ sent: false, reason: "already_resolved" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions/session-1/respond");
  });

  it("422 INPUT_RESPONSE_NOT_SUPPORTED는 failed로 구분한다", async () => {
    fetchMock.mockResolvedValueOnce(detailResponse(
      false,
      422,
      JSON.stringify({ error: { code: "INPUT_RESPONSE_NOT_SUPPORTED" } }),
    ));

    const result = await submitInputResponse("session-1", "request-1", "node-1", "질문", "답");

    expect(result).toMatchObject({ sent: false, reason: "failed", status: 422 });
  });

  it("503은 상태와 본문을 담아 failed로 구분한다", async () => {
    fetchMock.mockResolvedValueOnce(detailResponse(
      false,
      503,
      JSON.stringify({ error: { code: "NODE_UNAVAILABLE" } }),
    ));

    const result = await submitInputResponse("session-1", "request-1", "node-1", "질문", "답");

    expect(result).toMatchObject({ sent: false, reason: "failed", status: 503 });
    expect(result).toHaveProperty("body", JSON.stringify({ error: { code: "NODE_UNAVAILABLE" } }));
  });

  it("망 예외는 상태 없이 failed로 구분한다", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await submitInputResponse("session-1", "request-1", "node-1", "질문", "답");

    expect(result).toEqual({ sent: false, reason: "failed" });
  });

  it("성공하면 sent로 끝난다", async () => {
    fetchMock.mockResolvedValueOnce(detailResponse(true, 200));

    const result = await submitInputResponse("session-1", "request-1", "node-1", "질문", "답");

    expect(result).toEqual({ sent: true });
  });
});
