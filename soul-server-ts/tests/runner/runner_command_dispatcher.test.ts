import { describe, expect, it, vi } from "vitest";

import type { EngineExecuteParams, EnginePort, SSEEventPayload } from
  "../../src/engine/protocol.js";
import { attachClaudeResultReceiptMetadata } from
  "../../src/engine/claude_result_receipt_metadata.js";
import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  applyInterventionCommandFrame,
  discardInterventionCommandFrame,
  closeCommandFrame,
  engineEventFrame,
  executeCommandFrame,
  interruptCommandFrame,
  invokeCommandFrame,
  prepareSessionCommandFrame,
} from "../../src/runner/frame_protocol.js";
import { InProcessRunnerCommandDispatcher } from
  "../../src/runner/runner_command_dispatcher.js";

function makeEngine(overrides: Partial<EnginePort> = {}): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/runner",
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
    ...overrides,
  };
}

async function drain<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe("RunnerCommandDispatcher", () => {
  it("moves private Claude Result proof into the legacy runner metadata envelope", async () => {
    const result = { type: "result", success: true, output: "done" } as const;
    attachClaudeResultReceiptMetadata(result, { inputUuid: "input-1" });
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({
      async *execute() { yield result; },
    }));

    const frames = await drain(dispatcher.executeFrames({
      agentSessionId: "session-1",
      prompt: "hello",
    }));

    expect(frames).toEqual([
      engineEventFrame(
        { type: "result", success: true, output: "done" },
        { claudeResultReceipt: { inputUuid: "input-1" } },
      ),
    ]);
  });

  it("ACKs execute by commandId and runs the JSON-round-tripped DTO", async () => {
    const executeToFrameChannel = vi.fn(async (params, channel) => {
      expect(params).not.toBe(sourceParams);
      await channel.emit(engineEventFrame({ type: "complete", timestamp: 1 }));
    });
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({ executeToFrameChannel }));
    const sourceParams = {
      agentSessionId: "session-1",
      prompt: "hello",
      sessionItems: [{ role: "user", content: "hello" }],
    };

    const result = await dispatcher.dispatch(executeCommandFrame("execute-1", sourceParams));

    expect(result).toMatchObject({
      kind: "command_result",
      commandId: "execute-1",
      result: { status: "ok" },
    });
    await expect(drain(dispatcher.events("execute-1"))).resolves.toEqual([
      engineEventFrame({ type: "complete", timestamp: 1 }),
    ]);
    expect(executeToFrameChannel).toHaveBeenCalledWith(
      expect.objectContaining(sourceParams),
      expect.anything(),
    );
  });

  it.each([
    {
      name: "V5",
      base: { usd: 17.288251, partial: false },
      expected: { session_cost_usd: 17.91 },
    },
    {
      name: "V10",
      base: { usd: 2.578251, partial: true },
      expected: { session_cost_usd: 3.2, session_cost_partial: true },
    },
  ])("stamps the $name session total on complete", async ({ base, expected }) => {
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({
      async *execute() {
        yield {
          type: "complete",
          turn_cost_usd: 0.621749,
          timestamp: 1,
        } as SSEEventPayload;
      },
    }));

    const frames = await drain(dispatcher.executeFrames({
      agentSessionId: "session-1",
      prompt: "hello",
      sessionCost: base,
    } as EngineExecuteParams));

    expect(frames[0]).toMatchObject({
      kind: "engine_event",
      payload: {
        type: "complete",
        turn_cost_usd: 0.621749,
        ...expected,
      },
    });
  });

  it.each([
    {
      name: "session cost base is missing",
      params: { agentSessionId: "session-1", prompt: "hello" },
      event: { type: "complete", turn_cost_usd: 0.621749, timestamp: 1 },
    },
    {
      name: "turn cost is missing",
      params: {
        agentSessionId: "session-1",
        prompt: "hello",
        sessionCost: { usd: 17.288251, partial: false },
      },
      event: { type: "complete", timestamp: 1 },
    },
  ])("leaves complete unchanged when $name", async ({ params, event }) => {
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({
      async *execute() {
        yield event as SSEEventPayload;
      },
    }));

    const [frame] = await drain(dispatcher.executeFrames(params as EngineExecuteParams));

    expect(frame).toMatchObject({ kind: "engine_event", payload: event });
    expect(frame).not.toHaveProperty("payload.session_cost_usd");
  });

  it("returns a correlated error for an execute DTO that is not JSON", async () => {
    const executeToFrameChannel = vi.fn();
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({ executeToFrameChannel }));

    const result = await dispatcher.dispatch({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "command",
      kind: "execute",
      commandId: "execute-invalid",
      params: {
        agentSessionId: "session-1",
        prompt: "hello",
        futureCallback: () => undefined,
      },
    });

    expect(result).toMatchObject({
      kind: "command_result",
      commandId: "execute-invalid",
      result: {
        status: "error",
        error: { code: "invalid_command" },
      },
    });
    expect(executeToFrameChannel).not.toHaveBeenCalled();
  });

  it("dispatches prepare, interrupt, and close with asynchronous ACKs", async () => {
    const prepareSessionRuntime = vi.fn();
    const interrupt = vi.fn().mockResolvedValue(true);
    const close = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({
      prepareSessionRuntime,
      interrupt,
      close,
    }));

    const results = await Promise.all([
      dispatcher.dispatch(prepareSessionCommandFrame("prepare-1", "session-1")),
      dispatcher.dispatch(interruptCommandFrame("interrupt-1")),
      dispatcher.dispatch(closeCommandFrame("close-1")),
    ]);

    expect(results.map((result) => [result.commandId, result.result.status])).toEqual([
      ["prepare-1", "ok"],
      ["interrupt-1", "ok"],
      ["close-1", "ok"],
    ]);
    expect(results[1]).toMatchObject({ result: { data: { interrupted: true } } });
    expect(prepareSessionRuntime).toHaveBeenCalledWith("session-1");
    expect(interrupt).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns commandId-correlated lifecycle errors", async () => {
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({
      async interrupt() { throw new Error("interrupt failed"); },
    }));

    await expect(dispatcher.dispatch(interruptCommandFrame("interrupt-error"))).resolves
      .toMatchObject({
        kind: "command_result",
        commandId: "interrupt-error",
        result: {
          status: "error",
          error: { code: "interrupt_failed", message: "interrupt failed" },
        },
      });
  });

  it("dispatches optional engine capabilities through the same command boundary", async () => {
    const deliverInputResponse = vi.fn().mockResolvedValue({ status: "delivered" });
    const engine = makeEngine() as EnginePort & {
      deliverInputResponse: typeof deliverInputResponse;
    };
    engine.deliverInputResponse = deliverInputResponse;
    const dispatcher = new InProcessRunnerCommandDispatcher(engine);

    await expect(dispatcher.dispatch(invokeCommandFrame(
      "invoke-1",
      "deliverInputResponse",
      ["request-1", { answer: "yes" }],
    ))).resolves.toMatchObject({
      commandId: "invoke-1",
      result: { status: "ok", data: { status: "delivered" } },
    });
    expect(deliverInputResponse).toHaveBeenCalledWith("request-1", { answer: "yes" });
  });

  it("keeps a pre-operation child connected and returns not_supported for live apply", async () => {
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine());

    await expect(dispatcher.dispatch(applyInterventionCommandFrame({
      commandId: "apply-intervention:rolling-restart",
      interventionId: "rolling-restart",
      interventionInput: { prompt: "new host, old child" },
    }))).resolves.toMatchObject({
      commandId: "apply-intervention:rolling-restart",
      result: { status: "ok", data: { status: "not_supported" } },
    });
    await expect(dispatcher.dispatch(discardInterventionCommandFrame({
      commandId: "discard-intervention:rolling-restart",
      interventionId: "rolling-restart",
    }))).resolves.toMatchObject({
      commandId: "discard-intervention:rolling-restart",
      result: { status: "ok", data: { status: "not_supported" } },
    });
  });
});
