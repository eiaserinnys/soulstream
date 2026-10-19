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
import { isLogicalTurnCompleteFrame } from "../../src/runner/engine_event_stream.js";

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

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "engine_event",
      metadata: { claudeResultReceipt: { inputUuid: "input-1" } },
      payload: {
        type: "result",
        success: true,
        output: "done",
        output_command_id: expect.stringMatching(/^execute:/),
      },
    });
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
      engineEventFrame({
        type: "complete",
        timestamp: 1,
        output_command_id: "execute-1",
      }),
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

  it("stamps trusted output command ids on assistant and text events before complete clears the command", async () => {
    const eventTypes = [
      "assistant_message",
      "text_start",
      "text_delta",
      "text_end",
      "complete",
    ];
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({
      async executeToFrameChannel(_params, channel) {
        for (const type of eventTypes) {
          await channel.emit(engineEventFrame({
            type,
            output_command_id: "engine-command-spoof",
            content: "event content",
            usage: { input_tokens: 7 },
            ...(type === "complete" ? { turn_cost_usd: 0.5 } : {}),
            timestamp: 1,
          }, { claudeResultReceipt: { inputUuid: "input-1" } }));
        }
      },
    }));

    const commandId = "dispatcher-command-1";
    await expect(dispatcher.dispatch(executeCommandFrame(commandId, {
      agentSessionId: "session-1",
      prompt: "hello",
      sessionCost: { usd: 10, partial: false },
    }))).resolves.toMatchObject({ result: { status: "ok" } });
    const frames = await drain(dispatcher.events(commandId));

    expect(frames.map(frame => frame.kind === "engine_event" ? frame.payload.type : null))
      .toEqual(eventTypes);
    for (const frame of frames) {
      expect(frame).toMatchObject({
        kind: "engine_event",
        payload: {
          output_command_id: commandId,
          content: "event content",
          usage: { input_tokens: 7 },
        },
      });
    }
    expect(frames.at(-1)).toMatchObject({
      metadata: { claudeResultReceipt: { inputUuid: "input-1" } },
      payload: { session_cost_usd: 10.5 },
    });
    expect(dispatcher.activeExecutionCommandId()).toBeUndefined();
  });

  it("binds one manifest and stamps execution context on result, error, observation, and complete", async () => {
    const usageSnapshot = {
      schema_version: 1,
      backend: "codex",
      provider: "codex",
      preset_id: "codex-sol",
      requested_model: "requested-model",
      provider_attribution: "configured_alias",
    };
    const executionInput = {
      schema_version: 1,
      command_id: null,
      input_id: "input-1",
      scope: "newly_observed_material",
      stage: "prepared",
      resumed: false,
      replayed: false,
      scope_match: "unverified",
      non_comparable_reasons: ["hidden_system_or_schema", "missing_source_token_breakdown"],
      estimate_method: "utf16_chars_div4_ceil_v1",
      parts: [],
    };
    const sourceParams = {
      agentSessionId: "session-1",
      prompt: "hello",
      usage_snapshot: usageSnapshot,
      execution_input: executionInput,
    };
    const sourceEvents = [
      { type: "result", model: "reported-model", timestamp: 1 },
      { type: "error", model: "reported-model", timestamp: 2 },
      {
        type: "usage_observation",
        schema_version: 1,
        timestamp: 3,
        output_command_id: "spoofed-command",
        input_id: "spoofed-input",
        usage_snapshot: { ...usageSnapshot, requested_model: "spoofed-model" },
        model: "reported-model",
        usage_scope: "command_delta",
        accounting_key: "spoofed-command",
        outcome: "interrupted",
        source: "opencode_step_finish",
        usage: {
          input_tokens: 4,
          cached_input_tokens: 2,
          cache_write_input_tokens: null,
          output_tokens: 5,
          reasoning_output_tokens: 1,
        },
        raw_usage: {
          input: 4,
          output: 4,
          reasoning: 1,
          cache_read: 2,
          cache_write: null,
          total: null,
        },
      },
      { type: "complete", model: "reported-model", timestamp: 4 },
    ] as SSEEventPayload[];
    let adapterParams: EngineExecuteParams | undefined;
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({
      async executeToFrameChannel(params, channel) {
        adapterParams = params;
        for (const event of sourceEvents) await channel.emit(engineEventFrame(event));
      },
    }));

    const commandId = "execute:usage-context";
    await expect(dispatcher.dispatch(executeCommandFrame(
      commandId,
      sourceParams as EngineExecuteParams,
    ))).resolves.toMatchObject({
      commandId,
      result: { status: "ok" },
    });
    const frames = await drain(dispatcher.events(commandId));
    const engineEvents = frames.filter((frame) => frame.kind === "engine_event");
    const manifest = engineEvents[0];
    if (!manifest || manifest.kind !== "engine_event") throw new Error("manifest frame missing");

    expect(engineEvents.map((frame) => frame.kind === "engine_event" ? frame.payload.type : null))
      .toEqual([
        "input_material_manifest",
        "result",
        "error",
        "usage_observation",
        "complete",
      ]);
    expect(engineEvents.filter((frame) => frame.kind === "engine_event"
      && frame.payload.type === "input_material_manifest")).toHaveLength(1);
    expect(manifest).toMatchObject({
      payload: {
        type: "input_material_manifest",
        output_command_id: commandId,
        input_id: "input-1",
        usage_snapshot: usageSnapshot,
        execution_input: { command_id: commandId, input_id: "input-1", parts: [] },
      },
    });
    for (const frame of engineEvents.slice(1)) {
      expect(frame).toMatchObject({
        payload: {
          output_command_id: commandId,
          input_id: "input-1",
          usage_snapshot: usageSnapshot,
        },
      });
    }
    expect(engineEvents[1]).toMatchObject({ payload: { model: "reported-model" } });
    expect(engineEvents[3]).toMatchObject({ payload: { accounting_key: commandId } });
    expect(isLogicalTurnCompleteFrame(engineEvents[3]!)).toBe(false);
    expect(adapterParams).not.toBe(sourceParams);
    expect(adapterParams?.execution_input).not.toBe(sourceParams.execution_input);
    expect(adapterParams?.execution_input).toMatchObject({ command_id: commandId });
    expect(sourceParams.execution_input.command_id).toBeNull();
  });

  it("keeps consecutive execute output command ids separate", async () => {
    const dispatcher = new InProcessRunnerCommandDispatcher(makeEngine({
      async *execute() {
        yield {
          type: "assistant_message",
          output_command_id: "engine-command-spoof",
          content: "reply",
          timestamp: 1,
        } as SSEEventPayload;
        yield { type: "complete", timestamp: 2 } as SSEEventPayload;
      },
    }));

    const run = async (commandId: string) => {
      await dispatcher.dispatch(executeCommandFrame(commandId, {
        agentSessionId: "session-1",
        prompt: "hello",
      }));
      return drain(dispatcher.events(commandId));
    };
    const first = await run("dispatcher-command-1");
    const second = await run("dispatcher-command-2");

    expect(first.map(frame => frame.kind === "engine_event" ? frame.payload.output_command_id : null))
      .toEqual(["dispatcher-command-1", "dispatcher-command-1"]);
    expect(second.map(frame => frame.kind === "engine_event" ? frame.payload.output_command_id : null))
      .toEqual(["dispatcher-command-2", "dispatcher-command-2"]);
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
