import { describe, expect, it } from "vitest";

import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  RunnerFrameSchema,
  applyInterventionCommandFrame,
  discardInterventionCommandFrame,
  engineEventFrame,
  type RunnerFrame,
} from "../../src/runner/frame_protocol.js";

const frames: RunnerFrame[] = [
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "prepare_session",
    commandId: "prepare-1",
    agentSessionId: "session-1",
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "execute",
    commandId: "command-1",
    params: {
      agentSessionId: "session-1",
      prompt: "hello",
      runnerInterventionIds: ["intervention-1", "intervention-2", "intervention-3"],
      turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-1" },
      backendSessionRolloverFrom: "backend-session-old",
      sessionItems: [{ role: "user", content: "hello" }],
    },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "interrupt",
    commandId: "interrupt-1",
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "execution_status",
    commandId: "status-1",
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "stage_intervention",
    commandId: "stage-intervention-1",
    interventionId: "intervention-1",
    message: { text: "change course" },
    queued: false,
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "invoke",
    commandId: "apply-intervention-1",
    capability: "runner.apply_intervention",
    args: ["intervention-1", { prompt: "change course" }],
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "close",
    commandId: "close-1",
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "command",
    kind: "invoke",
    commandId: "invoke-1",
    capability: "compact",
    args: ["session-1"],
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
    channel: "event",
    kind: "request",
    correlationId: "ask-1",
    request: {
      kind: "can_use_tool",
      agentSessionId: "session-1",
      toolUseId: "tool-use-ask",
      toolName: "AskUserQuestion",
      input: { questions: [] },
    },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "event",
    kind: "request",
    correlationId: "approval-1",
    request: {
      kind: "tool_approval",
      approvalId: "approval-1",
      toolName: "drop_rows",
      input: { table: "events" },
    },
  },
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "command_result",
    commandId: "execute-1",
    result: { status: "ok", data: { accepted: true } },
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
    kind: "response",
    correlationId: "request-error-1",
    result: {
      status: "error",
      error: { code: "handler_error", message: "failed" },
    },
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
  {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    channel: "control",
    kind: "host_call_applied",
    correlationId: "host-1",
  },
];

class JsonLookingClassInstance {
  value = "looks serializable";
}

const forbiddenJsonValues = [
  ["function", () => undefined],
  ["Symbol", Symbol("process-local")],
  ["Date", new Date("2026-08-10T12:00:00.000Z")],
  ["Buffer", Buffer.from("process-local")],
  ["class instance", new JsonLookingClassInstance()],
] as const;

describe("runner frame protocol", () => {
  it("encodes live intervention application in the rolling-restart-safe invoke envelope", () => {
    expect(applyInterventionCommandFrame({
      commandId: "apply-intervention-1",
      interventionId: "intervention-1",
      interventionInput: { prompt: "change course" },
    })).toEqual({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "command",
      kind: "invoke",
      commandId: "apply-intervention-1",
      capability: "runner.apply_intervention",
      args: ["intervention-1", { prompt: "change course" }],
    });
  });

  it("encodes confirmed-miss cleanup in the rolling-restart-safe invoke envelope", () => {
    expect(discardInterventionCommandFrame({
      commandId: "discard-intervention-1",
      interventionId: "intervention-1",
    })).toEqual({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "command",
      kind: "invoke",
      commandId: "discard-intervention-1",
      capability: "runner.discard_intervention",
      args: ["intervention-1"],
    });
  });

  it("normalizes deep undefined while constructing observational engine frames", () => {
    expect(engineEventFrame({
      type: "debug",
      nested: { missing: undefined },
      values: [undefined],
    })).toMatchObject({
      kind: "engine_event",
      payload: { type: "debug", nested: {}, values: [null] },
    });
  });

  it.each(frames)("round-trips JSON frame $channel/$kind", (frame) => {
    const encoded = JSON.stringify(frame);
    const decoded: unknown = JSON.parse(encoded);

    expect(RunnerFrameSchema.parse(decoded)).toEqual(frame);
  });

  it("accepts additive fields on a known v1 frame", () => {
    const execute = frames.find(
      (frame): frame is Extract<RunnerFrame, { kind: "execute" }> => frame.kind === "execute",
    );
    expect(execute).toBeDefined();
    const frame = {
      ...execute,
      futureEnvelopeField: "ignored-by-v1",
      params: {
        ...execute?.params,
        futureParam: true,
      },
    };

    expect(RunnerFrameSchema.parse(frame)).toMatchObject(frame);
  });

  it.each(forbiddenJsonValues)("rejects %s in a known JSON field", (_name, value) => {
    const execute = frames.find(
      (frame): frame is Extract<RunnerFrame, { kind: "execute" }> => frame.kind === "execute",
    );
    expect(execute).toBeDefined();
    expect(RunnerFrameSchema.safeParse({
      ...execute,
      params: { ...execute?.params, sessionItems: [value] },
    }).success).toBe(false);
  });

  it.each(forbiddenJsonValues)("rejects %s in an additive unknown field", (_name, value) => {
    expect(RunnerFrameSchema.safeParse({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "command",
      kind: "close",
      commandId: "close-1",
      futureField: value,
    }).success).toBe(false);
  });

  it("rejects Symbol keys that JSON.stringify would silently omit", () => {
    const frame = {
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "command",
      kind: "close",
      commandId: "close-1",
    };
    Object.defineProperty(frame, Symbol("process-local"), { value: true });

    expect(RunnerFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("rejects an unknown protocol version", () => {
    expect(RunnerFrameSchema.safeParse({
      ...frames[0],
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION + 1,
    }).success).toBe(false);
  });
});
