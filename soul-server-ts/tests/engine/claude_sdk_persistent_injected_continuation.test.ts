import pino from "pino";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { ClaudeSdkClient } from "../../src/engine/claude_adapter.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_client_event.js";
import {
  abortSignal,
  collect,
  makeHarness,
  runOptions,
  sdkAssistantText,
  sdkCommandLifecycle,
  sdkInit,
  sdkInterruptedResult,
  sdkResult,
} from "./claude_sdk_persistent_test_harness.js";

const silentLogger = pino({ level: "silent" });

/**
 * CLI 2.1.288 frame orders measured with the real CLI (SDK 0.3.218). A machine
 * input injected at the tool boundary while the last text is being generated is
 * not consumed by that turn: the CLI ends the turn, then starts a turn of its
 * own for the injected input. That following turn belongs to the same
 * foreground turn.
 */
function newClient() {
  const harness = makeHarness();
  const client = new ClaudeSdkClient(
    { query: harness.queryFn, detachedEventSink: harness.detached, postResultDrainMs: 5 },
    silentLogger,
  );
  return { harness, client };
}

function startForeground(client: ClaudeSdkClient, uuid: string) {
  const events: ClaudeClientEvent[] = [];
  const done = (async () => {
    for await (const event of client.runPersistent(
      { ...runOptions("foreground"), inputUuid: uuid },
      abortSignal(),
    )) events.push(event);
  })();
  return { events, done };
}

function inject(client: ClaudeSdkClient, uuid: string): void {
  expect(client.injectAtToolBoundary({
    prompt: `injected ${uuid}`,
    inputUuid: uuid,
    turnOrigin: { kind: "runtime_followup", id: `delivery-${uuid}` },
  })).toBe(true);
}

function completes(events: ClaudeClientEvent[]) {
  return events.filter((event) => event.type === "complete");
}

function detachedTexts(detached: ReturnType<typeof makeHarness>["detached"]): string[] {
  return detached.mock.calls.flatMap(([event]) =>
    event.type === "text" ? [event.text] : []);
}

async function expectNextForegroundRuns(
  harness: ReturnType<typeof makeHarness>,
  client: ClaudeSdkClient,
  uuid: string,
): Promise<void> {
  const next = collect(client.runPersistent(
    { ...runOptions("next"), inputUuid: uuid },
    abortSignal(),
  ));
  const input = await harness.nextInput();
  expect(input.uuid).toBe(uuid);
  harness.push(sdkCommandLifecycle(uuid, "queued"));
  harness.push(sdkCommandLifecycle(uuid, "started"));
  harness.push(sdkResult("sdk-session", uuid, `${uuid} done`));
  await expect(next).resolves.toContainEqual(
    expect.objectContaining({ type: "complete", result: `${uuid} done` }),
  );
}

describe("persistent Claude session: injected input the CLI runs as a following turn", () => {
  it("T1 keeps the foreground open across the turn the CLI starts for an unconsumed injection", async () => {
    const { harness, client } = newClient();
    const foreground = startForeground(client, "U1");
    await harness.nextInput();
    harness.push(sdkCommandLifecycle("U1", "queued"));
    harness.push(sdkCommandLifecycle("U1", "started"));
    harness.push(sdkInit("sdk-session"));
    inject(client, "INJ");
    await harness.nextInput();

    harness.push(sdkCommandLifecycle("INJ", "queued"));
    harness.push({
      ...sdkAssistantText("a-first", "first turn text"),
      message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "first turn text" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 30 } },
    } as unknown as SDKMessage);
    harness.push({ ...sdkResult("sdk-session", "U1", "first turn done"),
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 30 },
    } as unknown as SDKMessage);
    harness.push(sdkCommandLifecycle("U1", "completed"));
    harness.push(sdkCommandLifecycle("INJ", "started"));
    harness.push(sdkInit("sdk-session"));
    harness.push({
      ...sdkAssistantText("a-follow", "following turn text"),
      message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "following turn text" }],
        usage: { input_tokens: 200, cache_read_input_tokens: 60 } },
    } as unknown as SDKMessage);
    harness.push({ ...sdkResult("sdk-session", "INJ", "following turn done"),
      usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 60 },
    } as unknown as SDKMessage);
    harness.push(sdkCommandLifecycle("INJ", "completed"));
    await foreground.done;

    expect(foreground.events).toContainEqual(
      expect.objectContaining({ type: "text", text: "first turn text" }),
    );
    expect(foreground.events).toContainEqual(
      expect.objectContaining({ type: "text", text: "following turn text" }),
    );
    expect(completes(foreground.events)).toEqual([
      expect.objectContaining({ type: "complete", result: "following turn done" }),
    ]);
    expect(foreground.events).not.toContainEqual(
      expect.objectContaining({ type: "result", output: "first turn done" }),
    );
    expect(detachedTexts(harness.detached)).toEqual([]);

    expect(completes(foreground.events)[0]).toMatchObject({
      usage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 90 },
      firstCall: { inputTokens: 130, cachedInputTokens: 30 },
      turnCostUsd: 0.001818,
    });
    expect(foreground.events.find(event => event.type === "result")).toMatchObject({
      usage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 90 },
    });

    await expectNextForegroundRuns(harness, client, "F2");
    expect(harness.close).not.toHaveBeenCalled();
    await client.close();
  });

  it("T2 ends the foreground at the only Result when the injection was consumed in the same turn", async () => {
    const { harness, client } = newClient();
    const foreground = startForeground(client, "U1");
    await harness.nextInput();
    harness.push(sdkCommandLifecycle("U1", "queued"));
    harness.push(sdkCommandLifecycle("U1", "started"));
    inject(client, "INJ");
    await harness.nextInput();

    harness.push(sdkCommandLifecycle("INJ", "queued"));
    harness.push(sdkCommandLifecycle("INJ", "started"));
    harness.push(sdkCommandLifecycle("INJ", "completed"));
    harness.push(sdkResult("sdk-session", "U1", "foreground done"));
    harness.push(sdkCommandLifecycle("U1", "completed"));
    await foreground.done;

    expect(completes(foreground.events)).toEqual([
      expect.objectContaining({ type: "complete", result: "foreground done" }),
    ]);
    await expectNextForegroundRuns(harness, client, "F2");
    await client.close();
  });

  it("T3 treats two injections the CLI starts together as one following turn", async () => {
    const { harness, client } = newClient();
    const foreground = startForeground(client, "U1");
    await harness.nextInput();
    harness.push(sdkCommandLifecycle("U1", "queued"));
    harness.push(sdkCommandLifecycle("U1", "started"));
    inject(client, "INJ1");
    await harness.nextInput();
    inject(client, "INJ2");
    await harness.nextInput();

    harness.push(sdkCommandLifecycle("INJ1", "queued"));
    harness.push(sdkCommandLifecycle("INJ2", "queued"));
    harness.push(sdkAssistantText("a-first", "first turn text"));
    harness.push(sdkResult("sdk-session", "U1", "first turn done"));
    harness.push(sdkCommandLifecycle("U1", "completed"));
    harness.push(sdkCommandLifecycle("INJ1", "started"));
    harness.push(sdkCommandLifecycle("INJ2", "started"));
    harness.push(sdkInit("sdk-session"));
    harness.push(sdkAssistantText("a-follow", "following turn text"));
    harness.push(sdkResult("sdk-session", "INJ2", "following turn done"));
    harness.push(sdkCommandLifecycle("INJ1", "completed"));
    harness.push(sdkCommandLifecycle("INJ2", "completed"));
    await foreground.done;

    expect(completes(foreground.events)).toEqual([
      expect.objectContaining({ type: "complete", result: "following turn done" }),
    ]);
    expect(detachedTexts(harness.detached)).toEqual([]);
    await expectNextForegroundRuns(harness, client, "F2");
    await client.close();
  });

  it("T5 keeps a second injection in the same foreground after the following turn has started", async () => {
    const { harness, client } = newClient();
    const foreground = startForeground(client, "U1");
    await harness.nextInput();
    harness.push(sdkCommandLifecycle("U1", "queued"));
    harness.push(sdkCommandLifecycle("U1", "started"));
    inject(client, "INJ1");
    await harness.nextInput();

    harness.push(sdkCommandLifecycle("INJ1", "queued"));
    harness.push(sdkResult("sdk-session", "U1", "first turn done"));
    harness.push(sdkCommandLifecycle("U1", "completed"));
    harness.push(sdkCommandLifecycle("INJ1", "started"));
    harness.push(sdkInit("sdk-session"));
    harness.push(sdkAssistantText("a-follow1", "following turn text for INJ1"));
    await vi.waitFor(() => expect(foreground.events).toContainEqual(
      expect.objectContaining({ type: "text", text: "following turn text for INJ1" }),
    ));
    expect(completes(foreground.events)).toEqual([]);

    inject(client, "INJ2");
    await harness.nextInput();
    harness.push(sdkCommandLifecycle("INJ2", "queued"));
    harness.push(sdkResult("sdk-session", "INJ1", "first following turn done"));
    harness.push(sdkCommandLifecycle("INJ1", "completed"));
    harness.push(sdkCommandLifecycle("INJ2", "started"));
    harness.push(sdkInit("sdk-session"));
    harness.push(sdkAssistantText("a-follow2", "following turn text for INJ2"));
    await vi.waitFor(() => expect(foreground.events).toContainEqual(
      expect.objectContaining({ type: "text", text: "following turn text for INJ2" }),
    ));
    expect(completes(foreground.events)).toEqual([]);

    harness.push(sdkResult("sdk-session", "INJ2", "second following turn done"));
    harness.push(sdkCommandLifecycle("INJ2", "completed"));
    await foreground.done;

    expect(foreground.events).toContainEqual(
      expect.objectContaining({ type: "text", text: "following turn text for INJ1" }),
    );
    expect(foreground.events).toContainEqual(
      expect.objectContaining({ type: "text", text: "following turn text for INJ2" }),
    );
    expect(completes(foreground.events)).toEqual([
      expect.objectContaining({ type: "complete", result: "second following turn done" }),
    ]);
    expect(detachedTexts(harness.detached)).toEqual([]);
    expect(harness.interrupt).not.toHaveBeenCalled();

    await expectNextForegroundRuns(harness, client, "F2");
    expect(harness.close).not.toHaveBeenCalled();
    await client.close();
  });

  it("T4 ends the foreground cleanly after an explicit intervention interrupt during the following turn", async () => {
    const { harness, client } = newClient();
    const foreground = startForeground(client, "U1");
    await harness.nextInput();
    harness.push(sdkCommandLifecycle("U1", "queued"));
    harness.push(sdkCommandLifecycle("U1", "started"));
    inject(client, "INJ");
    await harness.nextInput();

    harness.push(sdkCommandLifecycle("INJ", "queued"));
    harness.push(sdkAssistantText("a-first", "first turn text"));
    harness.push(sdkResult("sdk-session", "U1", "first turn done"));
    harness.push(sdkCommandLifecycle("U1", "completed"));
    harness.push(sdkCommandLifecycle("INJ", "started"));
    harness.push(sdkInit("sdk-session"));
    harness.push(sdkAssistantText("a-follow", "following turn text"));
    await vi.waitFor(() => expect(foreground.events).toContainEqual(
      expect.objectContaining({ type: "text", text: "following turn text" }),
    ));

    const interruption = client.interruptActiveTurnForSteer();
    await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledTimes(1));
    harness.push({
      ...sdkInterruptedResult("sdk-session", "INJ"),
      terminal_reason: "aborted_streaming",
    } as ReturnType<typeof sdkInterruptedResult>);
    harness.push(sdkCommandLifecycle("INJ", "cancelled"));
    await expect(interruption).resolves.toBe(true);
    await foreground.done;

    expect(foreground.events).not.toContainEqual(expect.objectContaining({ type: "error" }));
    expect(foreground.events).not.toContainEqual(
      expect.objectContaining({ type: "result", success: false }),
    );
    expect(harness.close).not.toHaveBeenCalled();

    await expectNextForegroundRuns(harness, client, "F2");
    expect(harness.close).not.toHaveBeenCalled();
    await client.close();
  });
});
