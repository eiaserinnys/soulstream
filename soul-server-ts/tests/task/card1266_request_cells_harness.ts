/**
 * 카드 #1266 U5b 바깥 요청 칸의 경계 시험 하니스다.
 *
 * 운영과 같은 조립으로 TaskManager와 TaskExecutor를 같은 Task에 물린다. 칸의 상태는
 * 운영 코드가 만드는 길(지연 로더, 실행 시작과 등록, 러너 복구, 종료 정리의 보유와 해제)로
 * 만들고, 요청은 TaskManager의 운영 진입 함수(cancelTask, addIntervention, ensureRunning,
 * deleteTask)로 보낸다. 판정 함수만 부르는 시험이 아니다.
 *
 * 재개 콜백은 운영의 `TaskRuntimeCommands.startResumedTask` 자리다. 실행을 대신 열고
 * (상태와 등록을 적고 활성화를 푼다) 연 기록만 남긴다. 실제 러너 실행을 여는 칸은
 * `executor.startNewExecution`을 직접 부른다.
 */
import pino from "pino";
import { vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionMutationHost } from "../../src/control_plane/persistence_host_clients.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SessionRow } from "../../src/db/session_db_types.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import type { RunnerEventFrame } from "../../src/runner/frame_protocol.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { nodeExecutionPhaseOfTask } from "../../src/task/state/node_execution_decision.js";
import type { NodeExecutionPhase } from "../../src/task/state/node_execution_machine.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type {
  AddInterventionParams,
  StartExecutionCallback,
} from "../../src/task/task_intervention_route.js";
import { TaskManager } from "../../src/task/task_manager.js";
import {
  createExecutionActivation,
  type ExecutionActivation,
  type Task,
} from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

export const SESSION_ID = "sess-cell";
export const REGISTRATION_ID = "registration-cell";
export const silentLogger = pino({ level: "silent" });

export const cellAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 중앙의 세션 줄이다. 지연 로더가 이 줄로 Task를 올린다. */
export function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: SESSION_ID,
    folder_id: null,
    display_name: null,
    node_id: "node-cell",
    session_type: "codex",
    status: "running",
    prompt: "original prompt",
    client_id: "client-1",
    claude_session_id: "thread-1",
    last_message: null,
    metadata: null,
    was_running_at_shutdown: false,
    last_event_id: 7,
    last_read_event_id: 0,
    created_at: new Date("2026-11-14T01:00:00.000Z"),
    updated_at: new Date("2026-11-14T01:05:00.000Z"),
    agent_id: cellAgent.id,
    caller_session_id: "caller-session",
    away_summary: null,
    termination_reason: null,
    termination_detail: null,
    termination_event_id: null,
    last_assistant_text: null,
    ...overrides,
  } as SessionRow;
}

/** 끝난 세션의 중앙 줄이다. */
export function terminalRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return sessionRow({
    status: "completed",
    termination_reason: "completed_ok",
    termination_event_id: 7,
    ...overrides,
  });
}

/** 실행 등록이 적힌 활성 세션의 중앙 줄이다(러너가 실행을 쥐고 있던 세션). */
export function registeredRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return sessionRow({
    execution_registration_id: REGISTRATION_ID,
    execution_command_id: "execute-1",
    ...overrides,
  } as Partial<SessionRow>);
}

export function fakeEngine(overrides: Record<string, unknown> = {}): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
    intervene: vi.fn(async () => ({ status: "delivered", mechanism: "active_turn" })),
    ...overrides,
  } as unknown as EnginePort;
}

export interface FakeRunnerOptions {
  registrationId?: string;
  /** 실행과 재생의 기록이다. 이 약속이 풀릴 때까지 턴과 재생은 끝나지 않는다. */
  frames?: Promise<void>;
  /** 엔진이 입력을 받는 실행이 서 있는가(살아 있는 러너의 턴). */
  acceptsInterventions?: boolean;
  interrupt?: () => Promise<boolean>;
  close?: () => Promise<void>;
  engine?: Record<string, unknown>;
}

/** 러너 프로세스의 dispatcher 대역이다. 쓰는 메서드만 둔다. */
export function fakeRunner(options: FakeRunnerOptions = {}) {
  const registrationId = options.registrationId ?? REGISTRATION_ID;
  const interrupt = vi.fn(options.interrupt ?? (async () => true));
  const close = vi.fn(options.close ?? (async () => {}));
  const detachHost = vi.fn(async () => {});
  const retireTerminalRegistration = vi.fn(async () => {});
  const frames = options.frames ?? Promise.resolve();
  const replay = () => (async function* (): AsyncGenerator<RunnerEventFrame> {
    await frames;
  })();
  const engine = fakeEngine(options.engine);
  const dispatcher = {
    recoverFrames: vi.fn(replay),
    executeFrames: vi.fn(replay),
    prepareExecutionIdentity: vi.fn(async () => ({
      registrationId,
      executionCommandId: "execute-new",
      pid: 4242,
      startIdentity: "start-cell",
    })),
    rollbackExecutionIdentity: vi.fn(async () => {}),
    registrationId: vi.fn(() => registrationId),
    waitForSessionAck: vi.fn(async () => null),
    hasActiveExecution: vi.fn(() => options.acceptsInterventions === true),
    activeExecutionCommandId: vi.fn(() => undefined),
    interrupt,
    close,
    detachHost,
    retireTerminalRegistration,
    dispatch: vi.fn(async () => {
      throw new Error("runner process is unavailable");
    }),
    lookupInterventionReceipt: vi.fn(async () => "unknown" as const),
    prepareSession: vi.fn(async () => {}),
    sendControlFrame: vi.fn(async () => true),
    requestContext: vi.fn(() => undefined),
  };
  const runner: TaskRunnerRuntime = {
    engine,
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
  };
  return {
    runner,
    dispatcher,
    engine: engine as EnginePort & { intervene: ReturnType<typeof vi.fn> },
    interrupt,
    close,
    detachHost,
    retireTerminalRegistration,
  };
}

export type FakeRunner = ReturnType<typeof fakeRunner>;

/** 디스크에 남은 러너 등록이다. 러너 복구가 이 등록으로 러너를 다시 붙인다. */
export function runnerRegistration(options: {
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed";
} = {}): RunnerRegistration {
  return {
    config: {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      backend: "codex",
      agent: cellAgent,
      paths: {
        sessionDirectory: `/runner/${SESSION_ID}`,
        databasePath: `/runner/${SESSION_ID}/runner.sqlite`,
        socketPath: `/runner/${SESSION_ID}/runner.sock`,
        pidPath: `/runner/${SESSION_ID}/runner.pid`,
        lockPath: `/runner/${SESSION_ID}/runner.lock`,
        configPath: `/runner/${SESSION_ID}/runner-config.json`,
      },
      codeSha: "sha-cell",
      snapshotPath: "/release/sha-cell/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 600_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 4242,
    registrationId: REGISTRATION_ID,
    pidStartIdentity: "start-cell",
    pidAlive: options.pidAlive ?? false,
    registeredAtMs: Date.parse("2026-11-14T01:00:00.000Z"),
    bootstrap: null,
    lifecycle: {
      session_id: SESSION_ID,
      runner_pid: 4242,
      execution_command_id: "execute-1",
      execution_state: options.lifecycleState ?? "completed",
      progress_seq: 3,
      progress_at: "2026-11-14T01:04:00.000Z",
      liveness_at: "2026-11-14T01:04:00.000Z",
      in_flight_tools: [],
      terminal_error: null,
    },
  } as unknown as RunnerRegistration;
}

export interface ResumeRecord {
  task: Task;
  runnerAtStart: TaskRunnerRuntime | undefined;
  queueAtStart: string[];
}

export interface WorldOptions {
  /** 실행 시작과 러너 복구가 붙일 러너다. */
  runner?: FakeRunner;
  /** 세대 넘김이 목표 프리셋을 찾는 목록과 새 세대 맥락을 짓는 쪽이다. */
  modelCatalog?: unknown;
  contextBuilder?: unknown;
}

/** 운영 조립과 같은 TaskManager와 TaskExecutor다. */
export function makeWorld(row: SessionRow | null = sessionRow(), options: WorldOptions = {}) {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const persistence = persistenceDouble.persistence;
  Object.assign(persistence as object, {
    enqueueMetadataEffect: vi.fn(async () => 1),
  });
  let centralRow = row;
  const getSession = vi.fn(async () => centralRow);
  const db = {
    getSession,
    updateSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } as unknown as SessionDB;
  const deleteSession = vi.fn(async () => undefined);
  const sessionMutations = {
    registerSession: vi.fn(async () => undefined),
    registerSessionWithWorktree: vi.fn(async () => undefined),
    transitionSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    deleteSession,
    acknowledgeReview: vi.fn(async () => "acknowledged"),
    setModelSelection: vi.fn(async () => undefined),
  } as unknown as SessionMutationHost;
  const broadcaster = {
    emitSessionCreated: vi.fn(async () => undefined),
    emitSessionDeleted: vi.fn(async () => undefined),
    emitCatalogUpdated: vi.fn(async () => undefined),
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
  const manager = new TaskManager(
    "node-cell",
    db,
    broadcaster,
    silentLogger,
    persistence,
    undefined,
    undefined,
    { moveSessionToFolder: vi.fn(async () => ({})) } as never,
    undefined,
    false,
    undefined,
    undefined,
    sessionMutations,
  );
  const completionNotifier = {
    notify: vi.fn(async () => undefined),
    notifyForDelete: vi.fn(async () => true),
  };
  manager.setCompletionNotifier(completionNotifier as never);
  const resumes: ResumeRecord[] = [];
  const onResume: StartExecutionCallback = (task, activation?: ExecutionActivation) => {
    resumes.push({
      task,
      runnerAtStart: task.runner,
      queueAtStart: task.interventionQueue.map((message) => message.text),
    });
    task.status = "running";
    task.executionRegistration = {
      registrationId: `registration-resumed-${resumes.length}`,
      executionCommandId: `command-resumed-${resumes.length}`,
    };
    if (activation) {
      if (task.executionActivation === activation) task.executionActivation = undefined;
      activation.resolve();
    }
  };
  const runner = options.runner;
  const runnerFactory = runner
    ? Object.assign(() => runner.runner, { recover: () => runner.runner })
    : undefined;
  const executor = new TaskExecutor(
    () => fakeEngine(),
    db,
    persistence,
    broadcaster,
    silentLogger,
    options.contextBuilder as never,
    completionNotifier as never,
    undefined,
    undefined,
    undefined,
    options.modelCatalog as never,
    runnerFactory as never,
    undefined,
    // 운영 조립(task_runtime_composition.ts)과 같이 끝난 실행 뒤의 쌓인 지시를 다시 띄운다.
    async (task: Task) => {
      await manager.resumeQueuedAfterTerminal(task, onResume);
    },
    undefined,
    sessionMutations,
  );
  const message = (text: string, overrides: Partial<AddInterventionParams> = {}) => ({
    agentSessionId: SESSION_ID,
    text,
    user: "browser",
    callerInfo: { source: "browser" as const },
    ...overrides,
  });
  return {
    manager,
    executor,
    persistence,
    persistenceDouble,
    completionNotifier,
    deleteSession,
    getSession,
    sessionMutations,
    resumes,
    onResume,
    message,
    runner,
    setCentralRow(next: SessionRow | null) { centralRow = next; },
    terminalReasons(): string[] {
      return persistenceDouble.enqueueTerminalTransitionAndWaitForApplication.mock.calls
        .map((call) => String((call[1] as SSEEventPayload & { termination_reason?: string })
          .termination_reason));
    },
    /** 다음 종료 응답 하나를 붙든다. 풀면 그대로 적용된다. */
    holdNextTerminalAnswer() {
      const gate = deferred();
      const mock = persistenceDouble.enqueueTerminalTransitionAndWaitForApplication;
      const original = mock.getMockImplementation()!;
      mock.mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        await gate.promise;
        return await original(...args);
      });
      return gate;
    },
    /** 다음 실행 등록의 응답 하나를 붙든다. */
    holdNextRegistrationAnswer() {
      const gate = deferred();
      const mock = persistenceDouble.recordExecutionRegistrationAndWaitForApplication;
      const original = mock.getMockImplementation()!;
      mock.mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        await gate.promise;
        return await original(...args);
      });
      return gate;
    },
    /** 다음 실행 전이(재개, 잇기)의 응답 하나를 붙든다. */
    holdNextRunningAnswer() {
      const gate = deferred();
      const mock = persistenceDouble.enqueueRunningTransitionAndWaitForApplication;
      const original = mock.getMockImplementation()!;
      mock.mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        await gate.promise;
        return await original(...args);
      });
      return gate;
    },
  };
}

export type CellWorld = ReturnType<typeof makeWorld>;

/** 지연 로더로 중앙 줄에서 Task를 올린다. 러너 복구 훑기가 쓰는 길이다. */
export async function hydrate(world: CellWorld): Promise<Task> {
  const task = await world.manager.hydrateRunnerRecoveryTask(SESSION_ID);
  if (!task) throw new Error("hydration failed");
  return task;
}

export async function flush(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 약속의 지금 상태를 본다. */
export function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; },
  );
  return state;
}

export function phaseOf(
  task: Task,
  options: Parameters<typeof nodeExecutionPhaseOfTask>[1] = {},
): NodeExecutionPhase {
  return nodeExecutionPhaseOfTask(task, {
    stopRequested: task.interruptBarrierKind === "stop",
    ...options,
  });
}

/** 실제 실행 시작이 러너를 붙이고 실행 등록을 올린 상태다. 등록 응답은 붙들려 있다. */
export async function startRegistering(world: CellWorld) {
  const registration = world.holdNextRegistrationAnswer();
  const task = await hydrate(world);
  task.status = "initializing";
  const started = world.executor.startNewExecution(task, cellAgent, createExecutionActivation());
  void Promise.resolve(started).catch(() => undefined);
  await flush();
  return { task, registration };
}

/** 실제 실행 시작이 등록을 마치고 턴을 도는 상태다. 턴은 러너의 기록이 풀릴 때 끝난다. */
export async function startRunning(world: CellWorld) {
  const { task, registration } = await startRegistering(world);
  registration.resolve();
  await flush();
  return task;
}

/** 러너 복구가 끝난 러너의 남은 기록을 오프라인으로 다시 읽는 상태다. */
export async function startReplaying(world: CellWorld) {
  const task = await hydrate(world);
  const recovery = world.executor.recoverRegisteredRunner(
    task,
    runnerRegistration({ lifecycleState: "completed" }),
    "execute-1",
    "offline",
  );
  void recovery.catch(() => undefined);
  await flush();
  return { task, recovery };
}

/** 러너 복구가 살아 있는 러너를 잇겠다고 알리고 응답을 기다리는 상태다. */
export async function startAdopting(world: CellWorld) {
  const answer = world.holdNextRunningAnswer();
  const task = await hydrate(world);
  const recovery = world.executor.recoverRegisteredRunner(
    task,
    runnerRegistration({ pidAlive: true, lifecycleState: "running" }),
    "execute-1",
    "adopt",
  );
  void recovery.catch(() => undefined);
  await flush();
  return { task, answer, recovery };
}
