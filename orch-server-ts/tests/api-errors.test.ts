import type { FastifyReply } from "fastify";

import { describe, expect, it } from "vitest";

import {
  mapNodeCommandError,
  sendApiError,
} from "../src/http/api_errors.js";
import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
} from "../src/node/pending_commands.js";
import { NodeCommandTransportError } from "../src/session/session_command_transport.js";

describe("shared API and node-command errors", () => {
  it("maps transport failures with the established node identity fields", () => {
    expect(mapNodeCommandError(new NodeCommandTransportError({
      code: "TRANSPORT_STALE",
      nodeId: "worker-1",
      connectionId: "connection-2",
      message: "transport changed",
    }))).toMatchObject({
      kind: "transport",
      statusCode: 503,
      apiError: {
        code: "TRANSPORT_STALE",
        message: "transport changed",
        nodeId: "worker-1",
        connectionId: "connection-2",
      },
    });
  });

  it("maps timeouts and retains their request id", () => {
    expect(mapNodeCommandError(new PendingNodeCommandTimeoutError({
      commandType: "status",
      requestId: "request-3",
      timeoutMs: 100,
    }))).toMatchObject({
      kind: "timeout",
      statusCode: 503,
      apiError: { code: "NODE_COMMAND_TIMEOUT" },
      requestId: "request-3",
    });
  });

  it("keeps rejected acknowledgement details available to route-specific parsers", () => {
    const response = { type: "error", status: "error", code: "SESSION_NOT_FOUND" };
    expect(mapNodeCommandError(new PendingNodeCommandRejectedError({
      commandType: "respond",
      requestId: "request-4",
      message: "session not found",
      response,
    }))).toMatchObject({
      kind: "rejected",
      statusCode: 503,
      requestId: "request-4",
      response,
    });
  });

  it("can emit both established API error envelopes", () => {
    const standard = replyRecorder();
    sendApiError(standard.reply, 503, { code: "NODE_DOWN", message: "offline" });
    expect(standard.status).toBe(503);
    expect(standard.body).toEqual({
      error: { code: "NODE_DOWN", message: "offline" },
    });

    const legacy = replyRecorder();
    sendApiError(
      legacy.reply,
      400,
      { code: "NODE_REJECTED", message: "invalid input" },
      { envelope: "detail" },
    );
    expect(legacy.status).toBe(400);
    expect(legacy.body).toEqual({
      detail: { error: { code: "NODE_REJECTED", message: "invalid input" } },
    });
  });
});

function replyRecorder() {
  const state: { status?: number; body?: unknown; reply: FastifyReply } = {
    reply: undefined as unknown as FastifyReply,
  };
  state.reply = {
    code(status: number) {
      state.status = status;
      return this;
    },
    send(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as FastifyReply;
  return state;
}
