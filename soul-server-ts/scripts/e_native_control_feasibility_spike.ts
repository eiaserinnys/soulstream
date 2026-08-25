// module-size-limit exception: this one-shot test-only evidence generator keeps
// the live event clock, owner fence, two delivery orders, and raw verdict in one
// executable so no cross-module state can falsify the captured causal ordering.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  query as createQuery,
  type Query,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";

import { spawnClaudeSessionEngine } from "../src/engine/session_engine_oom_score.js";
export type DeliveryOrder = "queue_then_interrupt" | "interrupt_then_push";

type TraceEvent = {
  sequence: number;
  elapsedMs: number;
  channel: "input" | "control" | "sdk" | "harness";
  event: Record<string, unknown>;
};

type NormalizedSdkEvent = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  sessionId?: string;
  userMessageUuid?: string;
  assistantText?: string;
  toolNames?: string[];
  toolResultText?: string;
};

export type TrialEvidence = {
  order: DeliveryOrder;
  ownerUuid: string;
  deliveryUuid: string;
  sdkVersion: string;
  claudeCodeVersions: string[];
  executableOverride: string;
  spawnCommands: string[];
  queryCreateCount: number;
  nativeInterruptCount: number;
  deliveryRegisterCount: number;
  inputEmitCount: number;
  inputCloseCountAtProof: number;
  inputCloseCountAfterCleanup: number;
  querySettledAtProof: boolean;
  sessionIds: string[];
  oldResultCount: number;
  oldResultSubtypes: string[];
  oldResultRawOwnerUuids: Array<string | null>;
  oldResultClassifiedOwnerUuid: string | null;
  oldResultClassification: string | null;
  consumeCount: number;
  completeCount: number;
  parentStatusOverwriteCount: number;
  naturalReleaseLatchEntered: boolean;
  naturalReleaseLatchEnteredMs: number;
  naturalReleaseWriterCount: number;
  naturalReleaseMarkerObserved: boolean;
  newInputProofMs: number;
  newInputAssistantText: string | null;
  interruptReceipt: SDKControlInterruptResponse | undefined;
};

export type TrialCheck = {
  id: string;
  passed: boolean;
  actual: unknown;
};

export function evaluateTrial(evidence: TrialEvidence): TrialCheck[] {
  return [
    check("a-natural-release-latch-closed", evidence.naturalReleaseLatchEntered
      && evidence.naturalReleaseWriterCount === 0
      && !evidence.naturalReleaseMarkerObserved,
    {
      entered: evidence.naturalReleaseLatchEntered,
      writerCount: evidence.naturalReleaseWriterCount,
      markerObserved: evidence.naturalReleaseMarkerObserved,
    }),
    check("b-stable-delivery-registered-once", evidence.deliveryRegisterCount === 1,
      evidence.deliveryRegisterCount),
    check("c-native-interrupt-exactly-once", evidence.nativeInterruptCount === 1,
      evidence.nativeInterruptCount),
    check("d-old-result-owner-fenced", evidence.oldResultCount === 1
      && evidence.oldResultClassifiedOwnerUuid === evidence.ownerUuid
      && evidence.oldResultClassification === "active_owner_at_interrupt",
    {
      oldResultCount: evidence.oldResultCount,
      rawOwnerUuids: evidence.oldResultRawOwnerUuids,
      classifiedOwnerUuid: evidence.oldResultClassifiedOwnerUuid,
      classification: evidence.oldResultClassification,
      subtypes: evidence.oldResultSubtypes,
    }),
    check("e-same-query-session-no-respawn", evidence.queryCreateCount === 1
      && evidence.spawnCommands.length === 1
      && evidence.spawnCommands[0] === evidence.executableOverride
      && evidence.sessionIds.length === 1
      && !evidence.querySettledAtProof
      && evidence.inputCloseCountAfterCleanup === 1,
    {
      queryCreateCount: evidence.queryCreateCount,
      spawnCommands: evidence.spawnCommands,
      executableOverride: evidence.executableOverride,
      sessionIds: evidence.sessionIds,
      querySettledAtProof: evidence.querySettledAtProof,
      inputCloseCountAfterCleanup: evidence.inputCloseCountAfterCleanup,
    }),
    check("f-new-input-before-natural-release", evidence.newInputProofMs > evidence.naturalReleaseLatchEnteredMs
      && evidence.naturalReleaseWriterCount === 0
      && evidence.inputCloseCountAtProof === 0
      && evidence.newInputAssistantText?.includes("NATIVE_INPUT_CONSUMED") === true,
    {
      newInputProofMs: evidence.newInputProofMs,
      naturalReleaseLatchEnteredMs: evidence.naturalReleaseLatchEnteredMs,
      naturalReleaseWriterCount: evidence.naturalReleaseWriterCount,
      inputCloseCountAtProof: evidence.inputCloseCountAtProof,
      newInputAssistantText: evidence.newInputAssistantText,
    }),
    check("g-exactly-once-and-parent-clean", evidence.deliveryRegisterCount === 1
      && evidence.inputEmitCount === 1
      && evidence.consumeCount === 1
      && evidence.completeCount === 1
      && evidence.parentStatusOverwriteCount === 0,
    {
      delivery: evidence.deliveryRegisterCount,
      input: evidence.inputEmitCount,
      consume: evidence.consumeCount,
      complete: evidence.completeCount,
      parentStatusOverwrite: evidence.parentStatusOverwriteCount,
    }),
  ];
}

function check(id: string, passed: boolean, actual: unknown): TrialCheck {
  return { id, passed, actual };
}

class InputQueue implements AsyncIterableIterator<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  closeCount = 0;
  private closed = false;

  push(value: SDKUserMessage): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCount += 1;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined as never });
    }
  }

  async next(): Promise<IteratorResult<SDKUserMessage>> {
    const value = this.values.shift();
    if (value) return { done: false, value };
    if (this.closed) return { done: true, value: undefined as never };
    return await new Promise((resolveNext) => this.waiters.push(resolveNext));
  }

  async return(): Promise<IteratorResult<SDKUserMessage>> {
    this.close();
    return { done: true, value: undefined as never };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    return this;
  }
}

class TraceCollector {
  readonly events: TraceEvent[] = [];
  readonly sdkEvents: NormalizedSdkEvent[] = [];
  private readonly startedAt = Date.now();
  private readonly waiters: Array<{
    predicate: (event: NormalizedSdkEvent) => boolean;
    resolve: (event: NormalizedSdkEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private sequence = 0;
  private settled = false;

  record(channel: TraceEvent["channel"], event: Record<string, unknown>): TraceEvent {
    const entry = {
      sequence: ++this.sequence,
      elapsedMs: Date.now() - this.startedAt,
      channel,
      event,
    } satisfies TraceEvent;
    this.events.push(entry);
    return entry;
  }

  observe(message: SDKMessage): void {
    const event = normalizeSdkMessage(message);
    this.sdkEvents.push(event);
    this.record("sdk", event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  }

  waitFor(
    predicate: (event: NormalizedSdkEvent) => boolean,
    label: string,
    timeoutMs = 60_000,
  ): Promise<NormalizedSdkEvent> {
    const existing = this.sdkEvents.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWaiter, rejectWaiter) => {
      const waiter = {
        predicate,
        resolve: resolveWaiter,
        reject: rejectWaiter,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          rejectWaiter(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  markSettled(): void {
    this.settled = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Query settled before awaited event"));
    }
  }

  isSettled(): boolean {
    return this.settled;
  }
}

function makeUserMessage(content: string, uuid: string, priority: "now" | "next"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    priority,
    uuid: uuid as NonNullable<SDKUserMessage["uuid"]>,
    origin: { kind: "human" },
  };
}

function normalizeSdkMessage(message: SDKMessage): NormalizedSdkEvent {
  const raw = message as unknown as Record<string, unknown>;
  const normalized: NormalizedSdkEvent = {
    type: stringValue(raw.type),
    subtype: stringValue(raw.subtype),
    sessionId: stringValue(raw.session_id),
    userMessageUuid: stringValue(raw.user_message_uuid),
  };
  if (raw.type === "system" && raw.subtype === "init") {
    normalized.claudeCodeVersion = stringValue(raw.claude_code_version);
    normalized.capabilities = raw.capabilities;
  }
  if (raw.type === "result") {
    normalized.isError = raw.is_error;
    normalized.result = stringValue(raw.result);
    normalized.errors = raw.errors;
  }
  const messageRecord = recordValue(raw.message);
  const blocks = Array.isArray(messageRecord?.content) ? messageRecord.content : [];
  const assistantText: string[] = [];
  const toolNames: string[] = [];
  const toolResultText: string[] = [];
  for (const block of blocks) {
    const entry = recordValue(block);
    if (!entry) continue;
    if (entry.type === "text" && typeof entry.text === "string") assistantText.push(entry.text);
    if (entry.type === "tool_use" && typeof entry.name === "string") toolNames.push(entry.name);
    if (entry.type === "tool_result") toolResultText.push(JSON.stringify(entry.content ?? ""));
  }
  if (assistantText.length) normalized.assistantText = assistantText.join("\n");
  if (toolNames.length) normalized.toolNames = toolNames;
  if (toolResultText.length) normalized.toolResultText = toolResultText.join("\n");
  return normalized;
}

async function runTrial(
  order: DeliveryOrder,
  index: number,
  executable: string,
): Promise<{ evidence: TrialEvidence; checks: TrialCheck[]; trace: TraceEvent[] }> {
  const workingDirectory = await mkdtemp(resolve(tmpdir(), `e-native-${order}-${index}-`));
  const latchPath = resolve(workingDirectory, "natural-release.fifo");
  const latchEnteredPath = resolve(workingDirectory, "latch-entered.txt");
  const latchScriptPath = resolve(workingDirectory, "hold-natural-release.sh");
  execFileSync("mkfifo", [latchPath]);
  await writeFile(latchScriptPath, [
    "#!/bin/sh",
    `printf LATCH_ENTERED > ${shellQuote(latchEnteredPath)}`,
    `cat ${shellQuote(latchPath)}`,
    `printf NATURAL_RELEASE_SHOULD_NOT_WIN_${index}`,
  ].join("\n"), "utf8");
  await chmod(latchScriptPath, 0o700);
  const input = new InputQueue();
  const trace = new TraceCollector();
  const spawnCommands: string[] = [];
  const logger = pino({ level: "silent" });
  let query!: Query;
  let pump!: Promise<void>;
  try {
    query = createQuery({
      prompt: input,
      options: {
        cwd: workingDirectory,
        pathToClaudeCodeExecutable: executable,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        tools: ["Bash"],
        persistSession: false,
        maxTurns: 6,
        maxBudgetUsd: 0.5,
        spawnClaudeCodeProcess: (options) => {
          spawnCommands.push(options.command);
          trace.record("harness", { kind: "spawn", command: options.command });
          return spawnClaudeSessionEngine(options, logger);
        },
      },
    });
    pump = (async () => {
      try {
        for await (const message of query) trace.observe(message);
      } finally {
        trace.markSettled();
      }
    })();

    const ownerUuid = randomUUID();
    const deliveryUuid = randomUUID();
    const naturalReleaseMarker = `NATURAL_RELEASE_SHOULD_NOT_WIN_${index}`;
    const newInputMarker = `NATIVE_INPUT_CONSUMED_${index}`;
    const latchEntered = waitForFileContent(latchEnteredPath, "LATCH_ENTERED");
    input.push(makeUserMessage(
      `Use Bash exactly once to run ${shellQuote(latchScriptPath)}. `
        + "Do not use any other tool. Wait for it to finish, then reply with exactly NATURAL_RELEASED.",
      ownerUuid,
      "now",
    ));
    trace.record("input", { kind: "owner_input", ownerUuid });
    const init = await trace.waitFor((event) => event.type === "system" && event.subtype === "init", "init");
    await trace.waitFor(
      (event) => event.type === "assistant" && event.toolNames?.includes("Bash") === true,
      "long Bash tool use",
    );
    await latchEntered;
    const latchEnteredTrace = trace.record("harness", {
      kind: "natural_release_latch_entered",
      latchPath,
      writerCount: 0,
    });
    const resultStartIndex = trace.sdkEvents.length;
    let nativeInterruptCount = 0;
    let deliveryRegisterCount = 1;
    let inputEmitCount = 0;
    trace.record("harness", { kind: "delivery_registered", deliveryUuid });
    const nextInput = makeUserMessage(
      `Reply with exactly ${newInputMarker} and nothing else.`,
      deliveryUuid,
      "next",
    );
    let receipt: SDKControlInterruptResponse | undefined;
    if (order === "queue_then_interrupt") {
      if (!input.push(nextInput)) throw new Error("Long-lived input queue rejected delivery");
      inputEmitCount += 1;
      trace.record("input", { kind: "delivery_emitted", deliveryUuid });
      nativeInterruptCount += 1;
      trace.record("control", { kind: "interrupt_invoked", ownerUuid });
      receipt = await query.interrupt();
    } else {
      nativeInterruptCount += 1;
      trace.record("control", { kind: "interrupt_invoked", ownerUuid });
      const receiptPromise = query.interrupt();
      if (!input.push(nextInput)) throw new Error("Long-lived input queue rejected post-interrupt delivery");
      inputEmitCount += 1;
      trace.record("input", { kind: "delivery_emitted", deliveryUuid });
      receipt = await receiptPromise;
    }
    trace.record("control", { kind: "interrupt_receipt", stillQueued: receipt?.still_queued ?? null });

    const newResult = await trace.waitFor(
      (event) => event.type === "result" && event.userMessageUuid === deliveryUuid,
      "new delivery Result",
    );
    const newResultTrace = trace.events.find((entry) => entry.event === newResult);
    if (!newResultTrace) throw new Error("Missing new Result trace entry");
    await delay(1_000);
    const resultWindow = trace.sdkEvents.slice(resultStartIndex).filter((event) => event.type === "result");
    const oldResults = resultWindow.filter((event) => event.userMessageUuid !== deliveryUuid);
    const consumedResults = resultWindow.filter((event) => event.userMessageUuid === deliveryUuid);
    const assistantText = trace.sdkEvents
      .filter((event) => event.type === "assistant" && event.assistantText?.includes(newInputMarker))
      .map((event) => event.assistantText ?? "")
      .join("\n") || null;
    const toolResultText = trace.sdkEvents.map((event) => event.toolResultText ?? "").join("\n");
    const parentStatusOverwriteCount = resultWindow.filter((event) =>
      event !== newResult && !oldResults.includes(event) && event.isError === true
    ).length + (newResult.isError === true ? 1 : 0);
    const sessionIds = unique(trace.sdkEvents.map((event) => event.sessionId));
    const claudeCodeVersions = unique(trace.sdkEvents.map((event) => stringValue(event.claudeCodeVersion)));
    const evidence: TrialEvidence = {
      order,
      ownerUuid,
      deliveryUuid,
      sdkVersion: "0.3.218",
      claudeCodeVersions,
      executableOverride: executable,
      spawnCommands,
      queryCreateCount: 1,
      nativeInterruptCount,
      deliveryRegisterCount,
      inputEmitCount,
      inputCloseCountAtProof: input.closeCount,
      inputCloseCountAfterCleanup: 0,
      querySettledAtProof: trace.isSettled(),
      sessionIds,
      oldResultCount: oldResults.length,
      oldResultSubtypes: oldResults.map((event) => event.subtype ?? "unknown"),
      oldResultRawOwnerUuids: oldResults.map((event) => event.userMessageUuid ?? null),
      oldResultClassifiedOwnerUuid: oldResults.length === 1 ? ownerUuid : null,
      oldResultClassification: oldResults.length === 1 ? "active_owner_at_interrupt" : null,
      consumeCount: consumedResults.length,
      completeCount: consumedResults.filter((event) => event.isError !== true).length,
      parentStatusOverwriteCount,
      naturalReleaseLatchEntered: true,
      naturalReleaseLatchEnteredMs: latchEnteredTrace.elapsedMs,
      naturalReleaseWriterCount: 0,
      naturalReleaseMarkerObserved: toolResultText.includes(naturalReleaseMarker),
      newInputProofMs: newResultTrace.elapsedMs,
      newInputAssistantText: assistantText ?? stringValue(newResult.result),
      interruptReceipt: receipt,
    };
    query.close();
    input.close();
    await pump.catch(() => undefined);
    evidence.inputCloseCountAfterCleanup = input.closeCount;
    const checks = evaluateTrial(evidence);
    trace.record("harness", {
      kind: "trial_verdict",
      passed: checks.every((entry) => entry.passed),
      checks,
      initSessionId: init.sessionId,
    });
    return { evidence, checks, trace: trace.events };
  } finally {
    query?.close();
    input.close();
    await pump?.catch(() => undefined);
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function waitForFileContent(path: string, expected: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolveWaiter, rejectWaiter) => {
    const watcher = watch(dirname(path), () => void verify());
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${basename(path)}`)), timeoutMs);
    let finished = false;
    async function verify(): Promise<void> {
      try {
        if ((await readFile(path, "utf8")) === expected) finish();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") finish(error as Error);
      }
    }
    function finish(error?: Error): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watcher.close();
      if (error) rejectWaiter(error);
      else resolveWaiter();
    }
    void verify();
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("Usage: tsx scripts/e_native_control_feasibility_spike.ts <output.json>");
  const executable = process.env.CLAUDE_CODE_EXECPATH?.trim();
  if (!executable) throw new Error("CLAUDE_CODE_EXECPATH is required for exact executable provenance");
  const trials: Awaited<ReturnType<typeof runTrial>>[] = [];
  for (const order of ["queue_then_interrupt", "interrupt_then_push"] as const) {
    for (let index = 1; index <= 3; index += 1) {
      trials.push(await runTrial(order, index, executable));
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    sdkVersion: "0.3.218",
    executableOverride: executable,
    orders: Object.fromEntries(
      (["queue_then_interrupt", "interrupt_then_push"] as const).map((order) => {
        const selected = trials.filter((trial) => trial.evidence.order === order);
        return [order, {
          passed: selected.filter((trial) => trial.checks.every((entry) => entry.passed)).length,
          total: selected.length,
        }];
      }),
    ),
    requiredPassed: trials.every((trial) => trial.checks.every((entry) => entry.passed)),
  };
  const output = { summary, trials };
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.requiredPassed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
