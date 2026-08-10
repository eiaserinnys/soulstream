import { describe, expect, it, vi } from "vitest";

import { InProcessRunnerFrameChannel } from "../../src/runner/in_process_frame_channel.js";
import {
  engineEventFrame,
  RUNNER_FRAME_PROTOCOL_VERSION,
  type RunnerEventFrame,
} from "../../src/runner/frame_protocol.js";

describe("InProcessRunnerFrameChannel", () => {
  it("ACKs an emitted frame only when the consumer advances", async () => {
    const channel = new InProcessRunnerFrameChannel();
    const afterAck = vi.fn();
    channel.start(async () => {
      await channel.emit(engineEventFrame({ type: "complete", result: "done" }));
      afterAck();
    });
    const iterator = channel[Symbol.asyncIterator]();

    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(afterAck).not.toHaveBeenCalled();
    const end = await iterator.next();
    expect(end.done).toBe(true);
    expect(afterAck).toHaveBeenCalledOnce();
  });

  it("correlates a request frame with exactly one control response", async () => {
    const channel = new InProcessRunnerFrameChannel();
    let responseStatus: string | undefined;
    channel.start(async () => {
      const response = await channel.request({
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        channel: "event",
        kind: "request",
        correlationId: "request-1",
        request: {
          kind: "schedule_tool_use",
          agentSessionId: "session-1",
          toolUseId: "tool-1",
          toolName: "ScheduleTask",
          input: { prompt: "later" },
          now: "2026-08-10T12:00:00.000Z",
        },
      });
      responseStatus = response.kind === "response" ? response.result.status : undefined;
    });
    const iterator = channel[Symbol.asyncIterator]();
    const request = await iterator.next();

    expect((request.value as RunnerEventFrame).kind).toBe("request");
    expect(channel.sendControl({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "control",
      kind: "response",
      correlationId: "unknown",
      result: { status: "ok" },
    })).toBe(false);
    expect(channel.sendControl({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "control",
      kind: "response",
      correlationId: "request-1",
      result: { status: "ok", data: { message: "scheduled" } },
    })).toBe(true);

    expect((await iterator.next()).done).toBe(true);
    expect(responseStatus).toBe("ok");
  });

  it("propagates producer failure after already delivered frames", async () => {
    const channel = new InProcessRunnerFrameChannel();
    channel.start(async () => {
      await channel.emit(engineEventFrame({ type: "session", session_id: "session-1" }));
      throw new Error("producer failed");
    });
    const iterator = channel[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).rejects.toThrow("producer failed");
  });

  it("interrupts an unanswered request, clears pending state, and drains execution", async () => {
    const channel = new InProcessRunnerFrameChannel();
    const controller = new AbortController();
    let rejection: unknown;
    channel.start(async () => {
      try {
        await channel.request({
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event",
          kind: "request",
          correlationId: "request-interrupt",
          timeoutMs: 1_000,
          request: {
            kind: "schedule_tool_use",
            agentSessionId: "session-1",
            toolUseId: "tool-1",
            toolName: "ScheduleTask",
            input: {},
            now: "2026-08-10T12:00:00.000Z",
          },
        }, { signal: controller.signal, timeoutMs: 1_000 });
      } catch (error) {
        rejection = error;
      }
    });
    const iterator = channel[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "request", correlationId: "request-interrupt" },
    });
    expect(channel.pendingControlCount).toBe(1);

    controller.abort(new Error("interrupted"));

    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(channel.pendingControlCount).toBe(0);
    expect(rejection).toMatchObject({ message: "interrupted" });
  });

  it("times out and removes an unanswered request before it can leak", async () => {
    const channel = new InProcessRunnerFrameChannel();
    channel.start(async () => {
      await channel.request({
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        channel: "event",
        kind: "request",
        correlationId: "request-timeout",
        timeoutMs: 10,
        request: {
          kind: "schedule_tool_use",
          agentSessionId: "session-1",
          toolUseId: "tool-1",
          toolName: "ScheduleTask",
          input: {},
          now: "2026-08-10T12:00:00.000Z",
        },
      }, { timeoutMs: 10 });
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(channel.pendingControlCount).toBe(0);
    await expect(channel[Symbol.asyncIterator]().next()).rejects.toThrow(
      "Runner request timed out after 10ms",
    );
  });

  it("aborts and removes pending controls when the consumer closes", async () => {
    const channel = new InProcessRunnerFrameChannel();
    let rejection: unknown;
    channel.start(async () => {
      try {
        await channel.request({
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event",
          kind: "request",
          correlationId: "request-close",
          request: {
            kind: "schedule_tool_use",
            agentSessionId: "session-1",
            toolUseId: "tool-1",
            toolName: "ScheduleTask",
            input: {},
            now: "2026-08-10T12:00:00.000Z",
          },
        });
      } catch (error) {
        rejection = error;
      }
    });
    const iterator = channel[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.();

    expect(channel.pendingControlCount).toBe(0);
    await vi.waitFor(() => {
      expect(rejection).toMatchObject({ message: "In-process runner frame channel closed" });
    });
  });
});
