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

async function main(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be unset; this harness uses account authentication");
  }

  const inputMessages: SDKUserMessage[] = [];
  const sdkMessages: SDKMessage[] = [];
  let interruptCalls = 0;
  const queryFn: ClaudeSdkQueryFn = (params) => {
    const prompt = observeInputs(params.prompt as AsyncIterable<SDKUserMessage>, inputMessages);
    const activeQuery = query({ ...params, prompt });
    return observeQuery(activeQuery, sdkMessages, () => {
      interruptCalls += 1;
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
    interruptCalls !== 0 && `interrupt calls=${interruptCalls}`,
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
    interruptCalls,
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

await main();
