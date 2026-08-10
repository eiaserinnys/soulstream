import { describe, expect, it } from "vitest";

import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  RunnerFrameSchema,
  type RunnerFrame,
} from "../../src/runner/frame_protocol.js";

const frames: RunnerFrame[] = [
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "execute",
    commandId: "command-1",
    params: {
      agentSessionId: "session-1",
      prompt: "hello",
      sessionItems: [{ role: "user", content: "hello" }],
    },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "engine_event",
    payload: { type: "session", session_id: "backend-session-1" },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "run_state_snapshot",
    snapshot: { backendId: "openai-agents", serialized: "state" },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "session_items_snapshot",
    snapshot: { backendId: "openai-agents", items: [{ role: "user" }] },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "request",
    correlationId: "request-1",
    request: {
      kind: "schedule_tool_use",
      agentSessionId: "session-1",
      toolUseId: "tool-use-1",
      toolName: "ScheduleTask",
      input: { prompt: "later" },
      now: "2026-08-10T12:00:00.000Z",
    },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "response",
    correlationId: "request-1",
    result: { status: "ok", data: { message: "scheduled" } },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "input_response",
    correlationId: "ask-1",
    answers: { choice: "yes" },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "tool_approval_response",
    correlationId: "approval-1",
    decision: "approved",
  },
];

describe("runner frame protocol", () => {
  it.each(frames)("round-trips JSON frame $channel/$kind", (frame) => {
    const encoded = JSON.stringify(frame);
    const decoded: unknown = JSON.parse(encoded);

    expect(RunnerFrameSchema.parse(decoded)).toEqual(frame);
  });

  it("accepts additive fields on a known v1 frame", () => {
    const frame = {
      ...frames[0],
      futureEnvelopeField: "ignored-by-v1",
      params: {
        ...(frames[0] as Extract<RunnerFrame, { kind: "execute" }>).params,
        futureParam: true,
      },
    };

    expect(RunnerFrameSchema.parse(frame)).toMatchObject(frame);
  });

  it("rejects process-local values and an unknown protocol version", () => {
    expect(RunnerFrameSchema.safeParse({
      ...frames[0],
      params: {
        ...(frames[0] as Extract<RunnerFrame, { kind: "execute" }>).params,
        sessionItems: [new Date()],
      },
    }).success).toBe(false);

    expect(RunnerFrameSchema.safeParse({
      ...frames[0],
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION + 1,
    }).success).toBe(false);
  });
});
