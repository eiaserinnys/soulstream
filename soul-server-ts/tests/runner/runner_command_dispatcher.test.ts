import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
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
