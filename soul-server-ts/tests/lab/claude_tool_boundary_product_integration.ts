import { execFileSync } from "node:child_process";

import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";

import { ClaudeEngineAdapter } from "../../src/engine/claude_adapter.js";
import {
  ClaudeSdkClient,
  type ClaudeSdkQueryFn,
} from "../../src/engine/claude_sdk_client.js";
import { findClaudeDeliveryTranscriptReceipt } from
  "../../src/engine/claude_delivery_transcript_receipt.js";
import { ClaudeSessionClientRegistry } from
  "../../src/engine/claude_session_client_registry.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";

const logger = pino({ level: "silent" });
const cliPath = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
const marker = `PRODUCT_1B_${Date.now()}`;
const toolMarker = `TOOL_DONE_${marker}`;
const ackMarker = `ACK_${marker}`;
const deliveryId = `delivery-${marker}`;
const deliveryInputUuid = buildDeliveryInputUuid(deliveryId);

/**
 * Real-CLI product checks of the tool-boundary injection path (ClaudeSdkClient
 * + registry + engine adapter). Scenario via argv[2]:
 * - `tool` (default): inject while a foreground Bash tool runs. One Result.
 * - `final-text`: inject while the final text is generated. The CLI ends that
 *   turn, then starts one for the injected input; the product must keep both in
 *   one foreground turn (two raw Results, one `complete` event).
 */
function assertAccountAuth(): void {
  if (process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be unset; this harness uses account authentication");
  }
}

function createProductHarness() {
  const inputMessages: SDKUserMessage[] = [];
  const sdkMessages: SDKMessage[] = [];
  const counters = { interruptCalls: 0 };
  const queryFn: ClaudeSdkQueryFn = (params) => {
    const prompt = observeInputs(params.prompt as AsyncIterable<SDKUserMessage>, inputMessages);
    const activeQuery = query({ ...params, prompt });
    return observeQuery(activeQuery, sdkMessages, () => {
      counters.interruptCalls += 1;
    });
  };
  const client = new ClaudeSdkClient(
    {
      query: queryFn,
      postResultDrainMs: 100,
      resolveClaudeExecutablePath: () => cliPath,
    },
    logger,
  );
  const registry = new ClaudeSessionClientRegistry(
    () => client,
    { idleTtlMs: 300_000, maxEntries: 2 },
  );
  const engine = new ClaudeEngineAdapter(
    {
      workspaceDir: process.cwd(),
      persistentSessionRegistry: registry,
      processEnv: process.env,
    },
    logger,
  );
  return { inputMessages, sdkMessages, counters, registry, engine };
}

async function runToolScenario(): Promise<void> {
  assertAccountAuth();
  const { inputMessages, sdkMessages, counters, registry, engine } = createProductHarness();
  const events: Array<Record<string, unknown>> = [];
  let injection: unknown;

  try {
    for await (const event of engine.execute({
      agentSessionId: `agent-${marker}`,
      prompt: "Use the Bash tool exactly once, in the foreground, with the exact command "
        + `\`timeout 45 tail -f /dev/null; printf '${toolMarker}'\`. Do not background it. `
        + `After the tool returns, reply exactly PRIMARY_DONE_${marker}.`,
      allowedTools: ["Bash"],
      model: "sonnet",
      useMcp: false,
      claudePermissionMode: "bypassPermissions",
    })) {
      events.push(event as unknown as Record<string, unknown>);
      if (event.type === "tool_start" && injection === undefined) {
        await delay(1_500);
        injection = await engine.injectAtToolBoundary({
          prompt: "Do not cancel or reinterpret current work. "
            + `At the next safe model step reply exactly ${ackMarker}.`,
          inputUuid: deliveryInputUuid,
          turnOrigin: { kind: "completion_notification", id: deliveryId },
        });
      }
    }
  } finally {
    await registry.shutdown();
  }

  const toolResultIndex = sdkMessages.findIndex((message) => (
    message.type === "user" && JSON.stringify(message).includes(toolMarker)
  ));
  const ackIndex = sdkMessages.findIndex((message) => (
    message.type === "assistant" && JSON.stringify(message).includes(ackMarker)
  ));
  const results = sdkMessages.filter((message) => message.type === "result");
  const injectedInput = inputMessages.find((message) => message.uuid === deliveryInputUuid);
  const receipt = findClaudeDeliveryTranscriptReceipt(
    [
      injectedInput as unknown as SessionMessage,
      sdkMessages[ackIndex] as unknown as SessionMessage,
    ],
    deliveryInputUuid,
  );
  const failures = [
    inputMessages.length !== 2 && `expected 2 inputs, got ${inputMessages.length}`,
    injectedInput?.priority !== "next" && `injected priority=${injectedInput?.priority}`,
    injectedInput?.origin?.kind !== "coordinator"
      && `injected origin=${JSON.stringify(injectedInput?.origin)}`,
    JSON.stringify(injection) !== JSON.stringify({ status: "delivered", mechanism: "active_turn" })
      && `injection=${JSON.stringify(injection)}`,
    counters.interruptCalls !== 0 && `interrupt calls=${counters.interruptCalls}`,
    toolResultIndex < 0 && "tool completion marker missing",
    ackIndex <= toolResultIndex && `ack index ${ackIndex} was not after tool result ${toolResultIndex}`,
    results.length !== 1 && `expected one Result, got ${results.length}`,
    results.some((message) => message.subtype === "error_during_execution")
      && "error_during_execution Result observed",
    results.some((message) => message.terminal_reason !== "completed")
      && `non-completed Result=${JSON.stringify(results)}`,
    events.some((event) => event.type === "error") && "product error event observed",
    receipt.kind !== "completed" && `delivery receipt=${JSON.stringify(receipt)}`,
  ].filter((failure): failure is string => typeof failure === "string");

  const result = results[0];
  const summary = {
    cliVersion: execFileSync(cliPath, ["--version"], { encoding: "utf8" }).trim(),
    inputCount: inputMessages.length,
    injectedPriority: injectedInput?.priority ?? null,
    injectedOrigin: injectedInput?.origin ?? null,
    interruptCalls: counters.interruptCalls,
    toolResultIndex,
    ackIndex,
    resultCount: results.length,
    resultSubtype: result?.subtype ?? null,
    resultTerminalReason: result?.terminal_reason ?? null,
    resultUserMessageUuid: result?.user_message_uuid ?? null,
    foregroundInputUuid: inputMessages[0]?.uuid ?? null,
    deliveryInputUuid,
    receipt,
    productErrorCount: events.filter((event) => event.type === "error").length,
    failures,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

async function runFinalTextScenario(): Promise<void> {
  assertAccountAuth();
  const { inputMessages, sdkMessages, counters, registry, engine } = createProductHarness();
  const events: Array<Record<string, unknown>> = [];
  let injection: unknown;
  let finished = false;
  // The product does not stream partial messages. The raw `thinking_tokens`
  // updates are the only sign, before the final text lands, that the model is
  // generating; the second one arrives as the text starts to stream.
  const injector = (async () => {
    const deadline = Date.now() + 60_000;
    while (!finished && Date.now() < deadline) {
      const progress = sdkMessages.filter((message) => (
        message.type === "system"
        && (message as unknown as { subtype?: string }).subtype === "thinking_tokens"
      )).length;
      if (progress >= 2) {
        injection = await engine.injectAtToolBoundary({
          prompt: `Reply with exactly ${ackMarker} and nothing else.`,
          inputUuid: deliveryInputUuid,
          turnOrigin: { kind: "completion_notification", id: deliveryId },
        });
        return;
      }
      await delay(50);
    }
  })();

  try {
    for await (const event of engine.execute({
      agentSessionId: `agent-${marker}`,
      prompt: "Do not use any tools. Write the integers from 1 to 300, one per line. "
        + `After the last number write a final line PRIMARY_DONE_${marker}.`,
      model: "haiku",
      useMcp: false,
      claudePermissionMode: "bypassPermissions",
    })) {
      events.push(event as unknown as Record<string, unknown>);
    }
  } finally {
    finished = true;
    await injector;
    await registry.shutdown();
  }

  const foregroundUuid = inputMessages[0]?.uuid ?? null;
  const labelOf = (uuid: unknown): string =>
    uuid === foregroundUuid ? "U1" : uuid === deliveryInputUuid ? "INJ" : String(uuid);
  const rawResults = sdkMessages.filter((message) => message.type === "result");
  const lifecycle = sdkMessages
    .map((message) => message as unknown as Record<string, unknown>)
    .filter((message) => message.type === "command_lifecycle")
    .map((message) => `${labelOf(message.command_uuid)}:${String(message.state)}`);
  const completes = events.filter((event) => event.type === "complete");
  const productResults = events.filter((event) => event.type === "result");
  const ackTextIndex = events.findIndex((event) => (
    event.type === "assistant_message" && String(event.content).includes(ackMarker)
  ));
  const completeResult = String(completes[0]?.result ?? "");
  const failures = [
    inputMessages.length !== 2 && `expected 2 inputs, got ${inputMessages.length}`,
    JSON.stringify(injection) !== JSON.stringify({ status: "delivered", mechanism: "active_turn" })
      && `injection=${JSON.stringify(injection)}`,
    counters.interruptCalls !== 0 && `interrupt calls=${counters.interruptCalls}`,
    rawResults.length !== 2
      && `expected 2 raw Results (injection did not land in the final generation?), got ${rawResults.length}`,
    rawResults[0] && labelOf(rawResults[0].user_message_uuid) !== "U1"
      && `first raw Result owner=${labelOf(rawResults[0].user_message_uuid)}`,
    rawResults[1] && labelOf(rawResults[1].user_message_uuid) !== "INJ"
      && `second raw Result owner=${labelOf(rawResults[1].user_message_uuid)}`,
    completes.length !== 1 && `expected one complete event, got ${completes.length}`,
    productResults.length !== 1 && `expected one product result event, got ${productResults.length}`,
    !completeResult.includes(ackMarker) && `complete result is not the following turn's: ${completeResult.slice(-60)}`,
    ackTextIndex < 0 && "following turn text missing from the foreground output",
    events.some((event) => event.type === "error") && "product error event observed",
  ].filter((failure): failure is string => typeof failure === "string");

  const summary = {
    scenario: "final-text",
    cliVersion: execFileSync(cliPath, ["--version"], { encoding: "utf8" }).trim(),
    inputCount: inputMessages.length,
    injection,
    interruptCalls: counters.interruptCalls,
    rawResultCount: rawResults.length,
    rawResultOwners: rawResults.map((message) => labelOf(message.user_message_uuid)),
    lifecycle,
    productEventTypes: events.map((event) => String(event.type)),
    completeCount: completes.length,
    completeResultTail: completeResult.slice(-60),
    ackTextIndex,
    productErrorCount: events.filter((event) => event.type === "error").length,
    failures,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

async function* observeInputs(
  input: AsyncIterable<SDKUserMessage>,
  observed: SDKUserMessage[],
): AsyncIterable<SDKUserMessage> {
  for await (const message of input) {
    observed.push(message);
    yield message;
  }
}

function observeQuery(
  activeQuery: Query,
  observed: SDKMessage[],
  onInterrupt: () => void,
): Query {
  const iterator = activeQuery[Symbol.asyncIterator]();
  return new Proxy(activeQuery, {
    get(target, property) {
      if (property === Symbol.asyncIterator) {
        return () => ({
          async next() {
            const next = await iterator.next();
            if (!next.done) observed.push(next.value);
            return next;
          },
          async return() {
            return await iterator.return?.() ?? { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() { return this; },
        });
      }
      if (property === "interrupt") {
        return async () => {
          onInterrupt();
          return await target.interrupt();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

const scenario = process.argv[2] ?? "tool";
if (scenario === "tool") await runToolScenario();
else if (scenario === "final-text") await runFinalTextScenario();
else throw new Error(`unknown scenario: ${scenario}`);
