// module-size-limit exception: this one-shot executable is the atomic evidence
// generator for two real-SDK scenarios. One global event clock, redaction path,
// assertion ledger, and finally-cleanup must stay together so a captured log is
// reproducible as one experiment; it is not imported by the production runtime.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  query as createQuery,
  type Query,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

type Scenario = "persistent_interrupt" | "background_runtime";
type Channel = "sdk" | "control" | "harness";

type HarnessRecord = {
  sequence: number;
  elapsed_ms: number;
  scenario: Scenario;
  channel: Channel;
  event: Record<string, unknown>;
};

type Assertion = {
  id: string;
  description: string;
  passed: boolean;
  evidence: Record<string, unknown>;
};

type ContractReport = {
  generated_at: string;
  sdk_version: "0.3.218";
  claude_code_version: string | null;
  claude_code_executable: string;
  required_assertions_passed: boolean;
  assertions: Assertion[];
  observations: Record<string, unknown>;
};

type EventWaiter = {
  predicate: (message: SDKMessage) => boolean;
  resolve: (message: SDKMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventQueue<T> = AsyncIterableIterator<T> & {
  push(value: T): boolean;
  close(): void;
};

const SDK_VERSION = "0.3.218" as const;
const CLAUDE_EXECUTABLE =
  process.env.CLAUDE_CONTRACT_EXECUTABLE ?? "claude";
const CONTRACT_TIMEOUT_MS = 90_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(SCRIPT_DIR, "../contracts/claude-sdk-0.3.218");
const RAW_LOG_PATH = resolve(OUTPUT_DIR, "raw-events.jsonl");
const ASSERTIONS_PATH = resolve(OUTPUT_DIR, "assertions.json");

const records: HarnessRecord[] = [];
let sequence = 0;

function record(
  startedAt: number,
  scenario: Scenario,
  channel: Channel,
  event: Record<string, unknown>,
): HarnessRecord {
  const entry: HarnessRecord = {
    sequence: ++sequence,
    elapsed_ms: Date.now() - startedAt,
    scenario,
    channel,
    event,
  };
  records.push(entry);
  appendFileSync(RAW_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

function createEventQueue<T>(): EventQueue<T> {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const queue: EventQueue<T> = {
    push(value) {
      if (closed) return false;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
      } else {
        values.push(value);
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined as T });
      }
    },
    async next() {
      const value = values.shift();
      if (value !== undefined) return { done: false, value };
      if (closed) return { done: true, value: undefined as T };
      return new Promise<IteratorResult<T>>((resolveNext) => {
        waiters.push(resolveNext);
      });
    },
    async return() {
      queue.close();
      return { done: true, value: undefined as T };
    },
    [Symbol.asyncIterator]() {
      return queue;
    },
  };
  return queue;
}

function makeUserMessage(
  content: string,
  uuid: string = randomUUID(),
  priority: SDKUserMessage["priority"] = "now",
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    priority,
    uuid: uuid as NonNullable<SDKUserMessage["uuid"]>,
    origin: { kind: "human" },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeMessage(message: SDKMessage): Record<string, unknown> {
  const raw = message as unknown as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    type: raw.type,
    ...(typeof raw.subtype === "string" ? { subtype: raw.subtype } : {}),
    ...(typeof raw.uuid === "string" ? { uuid: raw.uuid } : {}),
    ...(typeof raw.session_id === "string" ? { session_id: raw.session_id } : {}),
  };

  if (raw.type === "system" && raw.subtype === "init") {
    normalized.claude_code_version = raw.claude_code_version;
    normalized.capabilities = raw.capabilities;
    normalized.permission_mode = raw.permissionMode;
    normalized.tool_names = Array.isArray(raw.tools) ? raw.tools : [];
  } else if (raw.type === "result") {
    normalized.is_error = raw.is_error;
    normalized.user_message_uuid = raw.user_message_uuid;
    normalized.stop_reason = raw.stop_reason;
    normalized.terminal_reason = raw.terminal_reason;
    normalized.error_count = Array.isArray(raw.errors) ? raw.errors.length : 0;
  } else if (raw.type === "assistant") {
    const messageRecord = asRecord(raw.message);
    const content = messageRecord?.content;
    if (Array.isArray(content)) {
      normalized.blocks = content.map((block) => {
        const blockRecord = asRecord(block);
        if (!blockRecord) return { type: "unknown" };
        if (blockRecord.type === "tool_use") {
          const input = asRecord(blockRecord.input);
          return {
            type: "tool_use",
            id: blockRecord.id,
            name: blockRecord.name,
            input_keys: input ? Object.keys(input).sort() : [],
          };
        }
        return { type: blockRecord.type };
      });
    }
  } else if (raw.type === "user") {
    normalized.priority = raw.priority;
    normalized.should_query = raw.shouldQuery;
  } else if (raw.type === "system" && raw.subtype === "background_tasks_changed") {
    normalized.tasks = Array.isArray(raw.tasks)
      ? raw.tasks.map((task) => {
          const taskRecord = asRecord(task);
          return {
            task_id: taskRecord?.task_id,
            task_type: taskRecord?.task_type,
          };
        })
      : [];
  } else if (raw.type === "system" && raw.subtype === "task_notification") {
    normalized.task_id = raw.task_id;
    normalized.tool_use_id = raw.tool_use_id;
    normalized.status = raw.status;
    normalized.has_output_file =
      typeof raw.output_file === "string" && raw.output_file.length > 0;
  } else if (raw.type === "system" && raw.subtype === "session_state_changed") {
    normalized.state = raw.state;
  } else if (raw.type === "system" && raw.subtype === "task_started") {
    normalized.task_id = raw.task_id;
    normalized.tool_use_id = raw.tool_use_id;
  }

  return normalized;
}

class EventProbe {
  readonly messages: SDKMessage[] = [];
  readonly done: Promise<void>;
  private readonly waiters: EventWaiter[] = [];
  private pumpSettled = false;

  constructor(
    private readonly query: Query,
    private readonly scenario: Scenario,
    private readonly startedAt: number,
  ) {
    this.done = this.pump();
  }

  isSettled(): boolean {
    return this.pumpSettled;
  }

  async waitFor(
    predicate: (message: SDKMessage) => boolean,
    label: string,
    timeoutMs: number = CONTRACT_TIMEOUT_MS,
  ): Promise<SDKMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise<SDKMessage>((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectWait(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: resolveWait,
        reject: rejectWait,
        timer,
      });
    });
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.messages.push(message);
        record(this.startedAt, this.scenario, "sdk", normalizeMessage(message));
        for (const waiter of [...this.waiters]) {
          if (!waiter.predicate(message)) continue;
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
      record(this.startedAt, this.scenario, "harness", { kind: "iterator_done" });
    } catch (error) {
      record(this.startedAt, this.scenario, "harness", {
        kind: "iterator_error",
        error: error instanceof Error ? error.message : String(error),
      });
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    } finally {
      this.pumpSettled = true;
    }
  }
}

function isInit(message: SDKMessage): boolean {
  return message.type === "system" && message.subtype === "init";
}

function isResult(message: SDKMessage): boolean {
  return message.type === "result";
}

function isToolUseNamed(message: SDKMessage, name: string): boolean {
  if (message.type !== "assistant") return false;
  return message.message.content.some(
    (block) => block.type === "tool_use" && block.name === name,
  );
}

function findToolUseId(message: SDKMessage, name: string): string | null {
  if (message.type !== "assistant") return null;
  const block = message.message.content.find(
    (content) => content.type === "tool_use" && content.name === name,
  );
  return block?.type === "tool_use" ? block.id : null;
}

function isBackgroundLevel(
  message: SDKMessage,
  predicate: (taskCount: number) => boolean,
): boolean {
  return (
    message.type === "system" &&
    message.subtype === "background_tasks_changed" &&
    predicate(message.tasks.length)
  );
}

async function waitForMessageCount(
  probe: EventProbe,
  predicate: (message: SDKMessage) => boolean,
  count: number,
  label: string,
): Promise<SDKMessage> {
  const existing = probe.messages.filter(predicate);
  if (existing.length >= count) return existing[count - 1]!;
  let seen = existing.length;
  while (seen < count) {
    const startLength = probe.messages.length;
    const next = await probe.waitFor(
      (message) => {
        const index = probe.messages.indexOf(message);
        return index >= startLength && predicate(message);
      },
      `${label} (${seen + 1}/${count})`,
    );
    seen = probe.messages.slice(0, probe.messages.indexOf(next) + 1).filter(predicate).length;
    if (seen >= count) return next;
  }
  throw new Error(`Unreachable wait state for ${label}`);
}

async function waitForOptional(
  probe: EventProbe,
  predicate: (message: SDKMessage) => boolean,
  label: string,
  timeoutMs: number,
  startedAt: number,
  scenario: Scenario,
): Promise<SDKMessage | null> {
  try {
    return await probe.waitFor(predicate, label, timeoutMs);
  } catch (error) {
    record(startedAt, scenario, "harness", {
      kind: "optional_observation_timeout",
      label,
      timeout_ms: timeoutMs,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function settleAfterClose(
  query: Query,
  input: EventQueue<SDKUserMessage>,
  probe: EventProbe,
  startedAt: number,
  scenario: Scenario,
): Promise<void> {
  input.close();
  record(startedAt, scenario, "control", { kind: "input_closed" });
  query.close();
  record(startedAt, scenario, "control", { kind: "query_closed" });
  await Promise.race([
    probe.done,
    new Promise<never>((_, rejectWait) => {
      setTimeout(
        () => rejectWait(new Error(`Query iterator did not settle after close in ${scenario}`)),
        10_000,
      );
    }),
  ]);
}

async function runPersistentInterruptScenario(
  cwd: string,
): Promise<{
  init: SDKMessage;
  probe: EventProbe;
  queuedUuid: string;
  receipt: SDKControlInterruptResponse | undefined;
  receiptRecord: HarnessRecord;
  interruptedResult: SDKMessage;
  closeSettled: boolean;
}> {
  const scenario: Scenario = "persistent_interrupt";
  const startedAt = Date.now();
  const input = createEventQueue<SDKUserMessage>();
  const query = createQuery({
    prompt: input,
    options: {
      cwd,
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      tools: ["Bash"],
      persistSession: false,
      maxTurns: 6,
      maxBudgetUsd: 0.5,
    },
  });
  const probe = new EventProbe(query, scenario, startedAt);
  const initPromise = probe.waitFor(isInit, "SDK init");

  input.push(makeUserMessage("Reply with exactly TURN_ONE_DONE and nothing else."));
  const init = await initPromise;
  await waitForMessageCount(probe, isResult, 1, "first result");
  record(startedAt, scenario, "harness", {
    kind: "after_first_result",
    iterator_settled: probe.isSettled(),
  });

  input.push(makeUserMessage("Reply with exactly TURN_TWO_DONE and nothing else."));
  await waitForMessageCount(probe, isResult, 2, "second result");
  record(startedAt, scenario, "harness", {
    kind: "after_second_result",
    iterator_settled: probe.isSettled(),
  });

  input.push(
    makeUserMessage(
      'Use the Bash tool exactly once with command "sleep 20; printf HARNESS_LONG_DONE". ' +
        "Do not use another tool. After it finishes, reply with exactly LONG_DONE.",
    ),
  );
  await probe.waitFor(
    (message) => isToolUseNamed(message, "Bash"),
    "long-running Bash tool_use",
  );

  const queuedUuid = randomUUID();
  input.push(
    makeUserMessage(
      "The previous work was interrupted. Reply with exactly QUEUED_AFTER_INTERRUPT.",
      queuedUuid,
      "next",
    ),
  );
  record(startedAt, scenario, "control", {
    kind: "interrupt_requested",
    queued_uuid: queuedUuid,
  });
  const resultCountBeforeInterrupt = probe.messages.filter(isResult).length;
  const receipt = await query.interrupt();
  const receiptRecord = record(startedAt, scenario, "control", {
    kind: "interrupt_receipt",
    still_queued: receipt?.still_queued ?? null,
  });
  const interruptedResult = await waitForMessageCount(
    probe,
    isResult,
    resultCountBeforeInterrupt + 1,
    "interrupted turn result",
  );
  await probe.waitFor(
    (message) =>
      message.type === "result" &&
      "user_message_uuid" in message &&
      message.user_message_uuid === queuedUuid,
    "queued post-interrupt result",
  );

  await settleAfterClose(query, input, probe, startedAt, scenario);
  return {
    init,
    probe,
    queuedUuid,
    receipt,
    receiptRecord,
    interruptedResult,
    closeSettled: probe.isSettled(),
  };
}

async function runBackgroundRuntimeScenario(
  cwd: string,
): Promise<{
  init: SDKMessage;
  probe: EventProbe;
  backgroundCallResult: boolean;
  backgroundCallRecord: HarnessRecord;
  backgroundCallAttempts: number;
  result: SDKMessage;
  notification: SDKMessage | null;
  closeSettled: boolean;
}> {
  const scenario: Scenario = "background_runtime";
  const startedAt = Date.now();
  const input = createEventQueue<SDKUserMessage>();
  const query = createQuery({
    prompt: input,
    options: {
      cwd,
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      tools: ["Bash"],
      persistSession: false,
      maxTurns: 3,
      maxBudgetUsd: 0.5,
    },
  });
  const probe = new EventProbe(query, scenario, startedAt);
  const initPromise = probe.waitFor(isInit, "background SDK init");

  input.push(
    makeUserMessage(
      'Use the Bash tool exactly once with command "sleep 8; printf HARNESS_TASK_DONE" and set ' +
        "run_in_background to true. Do not use another tool. Immediately after the tool returns, " +
        "reply with exactly TASK_FOREGROUND_DONE without waiting for the background command.",
    ),
  );
  const init = await initPromise;
  const toolUseMessage = await probe.waitFor(
    (message) => isToolUseNamed(message, "Bash"),
    "background target Bash tool_use",
  );
  const toolUseId = findToolUseId(toolUseMessage, "Bash");
  if (!toolUseId) throw new Error("Bash tool_use did not carry an id");

  await probe.waitFor(
    (message) => isBackgroundLevel(message, (taskCount) => taskCount > 0),
    "non-empty background task level",
  );
  record(startedAt, scenario, "control", {
    kind: "background_tasks_requested",
    tool_use_id: toolUseId,
    state: "already_backgrounded",
  });
  const backgroundCallResult = await query.backgroundTasks(toolUseId);
  const backgroundCallRecord = record(startedAt, scenario, "control", {
    kind: "background_tasks_response",
    tool_use_id: toolUseId,
    state: "already_backgrounded",
    backgrounded: backgroundCallResult,
  });
  const backgroundCallAttempts = 1;

  const result = await probe.waitFor(isResult, "foreground result after explicit backgrounding");
  const notification = await waitForOptional(
    probe,
    (message) =>
      message.type === "system" &&
      message.subtype === "task_notification" &&
      message.tool_use_id === toolUseId,
    "background task terminal notification",
    20_000,
    startedAt,
    scenario,
  );
  await delay(1_000);

  await settleAfterClose(query, input, probe, startedAt, scenario);
  return {
    init,
    probe,
    backgroundCallResult,
    backgroundCallRecord,
    backgroundCallAttempts,
    result,
    notification,
    closeSettled: probe.isSettled(),
  };
}

function messageSequence(message: SDKMessage): number {
  const raw = message as unknown as Record<string, unknown>;
  const uuid = typeof raw.uuid === "string" ? raw.uuid : null;
  const match = [...records]
    .reverse()
    .find(
      (entry) =>
        entry.channel === "sdk" &&
        entry.event.type === raw.type &&
        entry.event.subtype === raw.subtype &&
        (uuid === null || entry.event.uuid === uuid),
    );
  return match?.sequence ?? -1;
}

function makeAssertion(
  id: string,
  description: string,
  passed: boolean,
  evidence: Record<string, unknown>,
): Assertion {
  return { id, description, passed, evidence };
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(RAW_LOG_PATH, "", "utf8");
  const tempCwd = await mkdtemp(resolve(tmpdir(), "soulstream-claude-contract-"));
  try {
    const persistent = await runPersistentInterruptScenario(tempCwd);
    const background = await runBackgroundRuntimeScenario(tempCwd);

    const persistentInit =
      persistent.init.type === "system" && persistent.init.subtype === "init"
        ? persistent.init
        : null;
    const backgroundInit =
      background.init.type === "system" && background.init.subtype === "init"
        ? background.init
        : null;
    const persistentSessionIds = new Set(
      persistent.probe.messages
        .map((message) => message.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    );
    const firstResultRecord = records.find(
      (entry) =>
        entry.scenario === "persistent_interrupt" &&
        entry.channel === "sdk" &&
        entry.event.type === "result",
    );
    const firstResultProbe = records.find(
      (entry) =>
        entry.scenario === "persistent_interrupt" &&
        entry.channel === "harness" &&
        entry.event.kind === "after_first_result",
    );
    const interruptedResultSequence = messageSequence(persistent.interruptedResult);
    const queuedResult = persistent.probe.messages.find(
      (message) =>
        message.type === "result" &&
        "user_message_uuid" in message &&
        message.user_message_uuid === persistent.queuedUuid,
    );
    const queuedResultSequence = queuedResult ? messageSequence(queuedResult) : -1;
    const backgroundResultSequence = messageSequence(background.result);
    const notificationSequence = background.notification
      ? messageSequence(background.notification)
      : -1;
    const backgroundLevels = background.probe.messages.filter(
      (message) =>
        message.type === "system" && message.subtype === "background_tasks_changed",
    );
    const backgroundLevelSizes = backgroundLevels.map((message) =>
      message.type === "system" && message.subtype === "background_tasks_changed"
        ? message.tasks.length
        : -1,
    );

    const assertions: Assertion[] = [
      makeAssertion(
        "persistent-query-survives-result",
        "A streaming Query remains open after a foreground Result.",
        firstResultRecord !== undefined &&
          firstResultProbe?.event.iterator_settled === false,
        {
          result_sequence: firstResultRecord?.sequence ?? null,
          iterator_settled_after_result:
            firstResultProbe?.event.iterator_settled ?? null,
        },
      ),
      makeAssertion(
        "persistent-query-session-stable",
        "Multiple foreground turns on one Query retain one Claude session id.",
        persistentSessionIds.size === 1,
        { session_ids: [...persistentSessionIds] },
      ),
      makeAssertion(
        "interrupt-receipt-capability",
        "The actual CLI advertises interrupt_receipt_v1.",
        persistentInit?.capabilities?.includes("interrupt_receipt_v1") === true,
        { capabilities: persistentInit?.capabilities ?? [] },
      ),
      makeAssertion(
        "interrupt-receipt-before-result",
        "A clean interrupt receipt resolves before the interrupted Result is emitted.",
        persistent.receiptRecord.sequence < interruptedResultSequence,
        {
          receipt_sequence: persistent.receiptRecord.sequence,
          interrupted_result_sequence: interruptedResultSequence,
        },
      ),
      makeAssertion(
        "interrupt-receipt-plus-local-ledger",
        "A locally queued UUID survives exactly once even when the CLI receipt snapshot omits it.",
        persistent.probe.messages.filter(
          (message) =>
            message.type === "result" &&
            "user_message_uuid" in message &&
            message.user_message_uuid === persistent.queuedUuid,
        ).length === 1,
        {
          queued_uuid: persistent.queuedUuid,
          still_queued: persistent.receipt?.still_queued ?? null,
          receipt_contains_queued_uuid:
            persistent.receipt?.still_queued.includes(persistent.queuedUuid) ?? null,
        },
      ),
      makeAssertion(
        "interrupt-queued-message-exactly-once",
        "The surviving queued UUID produces exactly one later Result.",
        persistent.probe.messages.filter(
          (message) =>
            message.type === "result" &&
            "user_message_uuid" in message &&
            message.user_message_uuid === persistent.queuedUuid,
        ).length === 1,
        { queued_result_sequence: queuedResultSequence },
      ),
      makeAssertion(
        "background-control-no-double-transition",
        "backgroundTasks(toolUseId) returns false once that task is already backgrounded.",
        !background.backgroundCallResult,
        {
          response_sequence: background.backgroundCallRecord.sequence,
          attempts: background.backgroundCallAttempts,
        },
      ),
      makeAssertion(
        "background-level-replace-set",
        "Background membership exposes a non-empty level and later returns to empty.",
        backgroundLevelSizes.some((size) => size > 0) &&
          backgroundLevelSizes.at(-1) === 0,
        { level_sizes: backgroundLevelSizes },
      ),
      makeAssertion(
        "background-notification-after-result",
        "The background task terminal notification can arrive after the foreground Result.",
        backgroundResultSequence > 0 &&
          notificationSequence > backgroundResultSequence,
        {
          foreground_result_sequence: backgroundResultSequence,
          task_notification_sequence: notificationSequence,
        },
      ),
      makeAssertion(
        "close-settles-iterators",
        "Query.close settles both actual SDK iterators.",
        persistent.closeSettled && background.closeSettled,
        {
          persistent_interrupt: persistent.closeSettled,
          background_runtime: background.closeSettled,
        },
      ),
    ];

  const report: ContractReport = {
      generated_at: new Date().toISOString(),
      sdk_version: SDK_VERSION,
      claude_code_version:
        persistentInit?.claude_code_version ??
        backgroundInit?.claude_code_version ??
        null,
    claude_code_executable:
      process.env.CLAUDE_CONTRACT_EXECUTABLE === undefined
        ? "PATH:claude"
        : "CLAUDE_CONTRACT_EXECUTABLE",
      required_assertions_passed: assertions.every((assertion) => assertion.passed),
      assertions,
      observations: {
        interrupt_result_subtype:
          persistent.interruptedResult.type === "result"
            ? persistent.interruptedResult.subtype
            : null,
        interrupt_receipt_still_queued_count:
          persistent.receipt?.still_queued.length ?? null,
        interrupt_receipt_omitted_local_queued_uuid:
          persistent.receipt?.still_queued.includes(persistent.queuedUuid) === false,
        background_level_sizes: backgroundLevelSizes,
        background_control_attempts: background.backgroundCallAttempts,
        background_control_after_level_result: background.backgroundCallResult,
        background_event_order_is_contractual: false,
        background_event_order_note:
          "SDK d.ts declares ordering between background level and edge events unspecified.",
      },
    };

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(ASSERTIONS_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    if (!report.required_assertions_passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    await writeFile(
      ASSERTIONS_PATH,
      `${JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          sdk_version: SDK_VERSION,
          claude_code_executable: CLAUDE_EXECUTABLE,
          required_assertions_passed: false,
          fatal_error: error instanceof Error ? error.message : String(error),
          assertions: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    throw error;
  } finally {
    await rm(tempCwd, { recursive: true, force: true });
  }
}

await main();
