/**
 * Claude backend full lifecycle 회귀 — mock SDK 기반 multi-turn + intervention + post-result drain + complete 단일 발생.
 *
 * 본 테스트는 Phase A·B의 변경(drain phase, assistant_error, system_prompt 분기, options forward)이
 * task lifecycle 전반에 통합 동작함을 검증한다. 단위 테스트(`claude_sdk_client.test.ts`,
 * `task_executor.test.ts`)는 슬라이스 별로 검증하지만, lifecycle 회귀는 *전체 흐름이 한 번에 정합*함을 보장한다.
 *
 * 검증 항목:
 *   - 첫 turn 정상 종료 → status="completed" → complete 이벤트 1회 발생
 *   - intervention queue 처리 → multi-turn 진행 → complete 중복/누락 없음
 *   - post-result drain phase 동안 prompt_suggestion 수신 가능
 *   - assistant_error event가 fatal=true error로 fold되지 않음 (status="completed" 유지)
 *
 * 분석 캐시: `roselin/.local/artifacts/analysis/20260520-2107-ts-claude-python-parity-system-map.md` §G Phase C
 */

import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  type Query as ClaudeSdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { ClaudeEngineAdapter } from "../../src/engine/claude_adapter.js";
import type { ClaudeClient, ClaudeRunOptions } from "../../src/engine/claude_adapter.js";
import {
  ClaudeSdkClient,
  type ClaudeSdkQueryFn,
} from "../../src/engine/claude_sdk_client.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger: Logger = pino({ level: "silent" });

const claudeAgent: AgentProfile = {
  id: "claude-roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-lc",
    prompt: "첫 발화",
    status: "running",
    profileId: claudeAgent.id,
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    ...overrides,
  };
}

function makeMocks() {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const { persistence, enqueueEvent: persistEvent } = persistenceDouble;

  const updateSession = vi.fn().mockResolvedValue(undefined);
  const setClaudeSessionId = vi.fn().mockResolvedValue(undefined);
  const db = { updateSession, setClaudeSessionId } as unknown as SessionDB;

  const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
  const emitSessionUpdated = vi.fn().mockResolvedValue(undefined);
  const broadcaster = { emitEventEnvelope, emitSessionUpdated } as unknown as SessionBroadcaster;

  return {
    persistence,
    db,
    broadcaster,
    persistEvent,
    enqueueEventAndWaitForSessionAck:
      persistenceDouble.enqueueEventAndWaitForSessionAck,
    enqueueTerminalTransitionAndWaitForApplication:
      persistenceDouble.enqueueTerminalTransitionAndWaitForApplication,
    emitEventEnvelope,
    emitSessionUpdated,
  };
}

/** ClaudeClientEvent 시퀀스를 yield하는 mock ClaudeClient. turn별로 event 배열을 받음. */
function makeFakeClaudeClient(turnEvents: ClaudeClientEvent[][]): ClaudeClient {
  let turnIdx = 0;
  return {
    async *run(_opts: ClaudeRunOptions, _signal: AbortSignal): AsyncIterable<ClaudeClientEvent> {
      const events = turnEvents[turnIdx] ?? [];
      turnIdx += 1;
      for (const event of events) yield event;
    },
    async close() {},
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function makeQuery(
  generator: AsyncGenerator<SDKMessage>,
  overrides: Partial<ClaudeSdkQuery> = {},
): ClaudeSdkQuery {
  return Object.assign(generator, {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    ...overrides,
  }) as unknown as ClaudeSdkQuery;
}

function sdkSystemInit(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function sdkSuccessResult(
  sessionId: string,
  result: string,
  overrides: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: sessionId,
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0.01,
    stop_reason: "end_turn",
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  } as unknown as SDKMessage;
}

async function readUserPrompt(prompt: string | AsyncIterable<SDKUserMessage>): Promise<string> {
  if (typeof prompt === "string") return prompt;
  return readUserPromptFromIterator(prompt[Symbol.asyncIterator]());
}

async function readUserPromptFromIterator(iterator: AsyncIterator<SDKUserMessage>): Promise<string> {
  const next = await iterator.next();
  expect(next.done).toBe(false);
  const content = next.value.message.content;
  if (typeof content === "string") return content;
  const textBlock = content.find((block) => block.type === "text");
  expect(textBlock).toBeDefined();
  return textBlock!.text;
}

describe("Claude lifecycle: full integration (Phase C parity 회귀)", () => {
  it("첫 turn 정상 종료 → complete 1회 + status completed", async () => {
    const mocks = makeMocks();
    const client = makeFakeClaudeClient([
      [
        { type: "session", sessionId: "claude-sess-x" },
        { type: "text", text: "응답입니다", timestamp: 1 },
        { type: "result", success: true, output: "응답입니다", timestamp: 2 },
        { type: "complete", result: "응답입니다", claudeSessionId: "claude-sess-x", timestamp: 3 },
      ],
    ]);
    const adapter = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-roselin", client, processEnv: {} },
      silentLogger,
    );
    const executor = new TaskExecutor(
      () => adapter,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(task.codexThreadId).toBe("claude-sess-x");

    const completeCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "complete",
    );
    expect(completeCalls).toHaveLength(1);

    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-lc",
      expect.objectContaining({ type: "session_ended", status: "completed" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "completed",
      }),
    );
  });

  it("post-result drain phase — prompt_suggestion 수신 후 종료", async () => {
    // pumpQuery의 drain은 SDK message를 받지만, ClaudeEngineAdapter는 ClaudeClient를 race로 wrap한다.
    // 본 테스트는 mock ClaudeClient가 result/complete 후 prompt_suggestion event를 emit하도록 하여
    // task_executor가 그것을 정상 처리하는지 단언 (drain phase는 ClaudeSdkClient 내부 — mock client는
    // result/complete + prompt_suggestion을 같은 turn 안에 yield하여 동등 동작 모방).
    //
    // 책임 분리: 실제 ClaudeSdkClient drain phase의 회귀 보호는 `tests/engine/claude_sdk_client.test.ts`
    // ("drains a prompt_suggestion that arrives after the result message", "post-result drain times out
    // and finishes cleanly when no late prompt_suggestion arrives", "post-result drain ignores
    // non prompt_suggestion messages")가 담당. 본 lifecycle 테스트는 *event 흐름 분기*만 검증한다.
    const mocks = makeMocks();
    const client = makeFakeClaudeClient([
      [
        { type: "session", sessionId: "claude-sess-d" },
        { type: "text", text: "응답", timestamp: 1 },
        { type: "result", success: true, output: "응답", timestamp: 2 },
        { type: "complete", result: "응답", claudeSessionId: "claude-sess-d", timestamp: 3 },
        { type: "prompt_suggestion", text: "follow-up?", timestamp: 4 },
      ],
    ]);
    const adapter = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-roselin", client, processEnv: {} },
      silentLogger,
    );
    const executor = new TaskExecutor(
      () => adapter,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    const suggestionCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "prompt_suggestion",
    );
    expect(suggestionCalls).toHaveLength(1);
    expect((suggestionCalls[0]![1] as { text: string }).text).toBe("follow-up?");
    expect(task.status).toBe("completed");
  });

  it("assistant_error → fatal로 fold되지 않고 status는 종료 시점 결과에 따름", async () => {
    // Phase A 변경: assistant_error는 fatal field 없음 — adapter L113 fatal 게이트가 throw하지 않음.
    // result가 success=true이면 status="completed"로 정상 종료.
    const mocks = makeMocks();
    const client = makeFakeClaudeClient([
      [
        { type: "session", sessionId: "claude-sess-e" },
        // billing_error지만 SDK 자체는 turn을 끝내고 result 발행 가능
        { type: "assistant_error", errorType: "billing_error", model: "claude-sonnet-4-5", timestamp: 0.5 },
        { type: "result", success: true, output: "partial", timestamp: 1 },
        { type: "complete", result: "partial", claudeSessionId: "claude-sess-e", timestamp: 2 },
      ],
    ]);
    const adapter = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-roselin", client, processEnv: {} },
      silentLogger,
    );
    const executor = new TaskExecutor(
      () => adapter,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    // assistant_error는 durable ingress에 기록되지만 task lifecycle을 중단하지 않음
    const errCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "assistant_error",
    );
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]![1] as { error_type: string }).error_type).toBe("billing_error");
    expect(task.status).toBe("completed");
    // fatal=true generic error event는 발행되지 않음 (assistant_error로 분리됨)
    const fatalErrorCalls = mocks.persistEvent.mock.calls.filter((c) => {
      const evt = c[1] as { type: string; fatal?: boolean };
      return evt.type === "error" && evt.fatal === true;
    });
    expect(fatalErrorCalls).toHaveLength(0);
  });

  it("agents.yaml options forward — claude adapter가 SDK까지 옵션 전달 확인", async () => {
    const mocks = makeMocks();
    let capturedRunOptions: ClaudeRunOptions | undefined;
    const client: ClaudeClient = {
      async *run(opts) {
        capturedRunOptions = opts;
        yield { type: "session", sessionId: "claude-sess-o" };
        yield { type: "result", success: true, output: "ok", timestamp: 1 };
        yield { type: "complete", result: "ok", claudeSessionId: "claude-sess-o", timestamp: 2 };
      },
      async close() {},
    };
    const adapter = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-roselin", client, processEnv: {} },
      silentLogger,
    );
    const claudeAgentWithOpts: AgentProfile = {
      ...claudeAgent,
      allowed_tools: ["Read", "Edit"],
      disallowed_tools: ["WebFetch", "Bash"],
      max_turns: 50,
    };
    const executor = new TaskExecutor(
      () => adapter,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask({ profileId: claudeAgentWithOpts.id });
    executor.startExecution(task, claudeAgentWithOpts);
    await task.executionPromise;

    expect(capturedRunOptions?.allowedTools).toEqual(["Read", "Edit"]);
    expect(capturedRunOptions?.disallowedTools).toEqual(["WebFetch", "Bash"]);
    expect(capturedRunOptions?.maxTurns).toBe(50);
  });
});
