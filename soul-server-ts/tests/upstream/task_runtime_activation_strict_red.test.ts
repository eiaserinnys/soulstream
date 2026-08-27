import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import type { SessionMutationHost } from
  "../../src/control_plane/persistence_host_clients.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { ExecutionActivation } from "../../src/task/task_models.js";
import { TaskRuntimeCommands } from
  "../../src/upstream/task_runtime_commands.js";
import type { SessionBroadcaster } from
  "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from
  "../task/event_persistence_test_double.js";

const logger = pino({ level: "silent" });

const agent: AgentProfile = {
  id: "strict-red-agent",
  name: "Strict RED Agent",
  backend: "codex",
  workspace_dir: "/tmp/strict-red-agent",
};

interface ActivationObservation {
  installed: ExecutionActivation | undefined;
  received: ExecutionActivation | undefined;
}

function makeHarness() {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const registerSession = vi.fn().mockResolvedValue(undefined);
  const sessionMutations = {
    registerSession,
    transitionSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    acknowledgeReview: vi.fn().mockResolvedValue("acknowledged"),
  } as unknown as SessionMutationHost;
  const db = {
    getFolderById: vi.fn().mockResolvedValue(null),
    getBoardItems: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(null),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitSessionCreated: vi.fn().mockResolvedValue(undefined),
    emitCatalogUpdated: vi.fn().mockResolvedValue(undefined),
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const registry = new AgentRegistry([agent]);
  const taskManager = new TaskManager(
    "strict-red-node",
    db,
    broadcaster,
    logger,
    persistenceDouble.persistence,
    undefined,
    registry,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    sessionMutations,
  );
  const autoResumeActivations: Array<ExecutionActivation | undefined> = [];
  const originalAddIntervention = taskManager.addIntervention.bind(taskManager);
  vi.spyOn(taskManager, "addIntervention").mockImplementation(
    (params, onResume) => originalAddIntervention(
      params,
      (task, activation) => {
        autoResumeActivations.push(activation);
        return onResume(task, activation);
      },
    ),
  );
  const executeInputs: EngineExecuteParams[] = [];
  const engineFactory = (): EnginePort => ({
    backendId: "codex",
    workspaceDir: agent.workspace_dir,
    async *execute(input: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
      executeInputs.push(input);
      yield {
        type: "assistant_message",
        content: "follow-up consumed",
        timestamp: Date.now() / 1000,
      };
      yield { type: "complete", timestamp: Date.now() / 1000 };
    },
    async interrupt() { return true; },
    async close() {},
  });
  const taskExecutor = new TaskExecutor(
    engineFactory,
    db,
    persistenceDouble.persistence,
    broadcaster,
    logger,
  );
  const activationObservations: ActivationObservation[] = [];
  const originalStartExecution = taskExecutor.startExecution.bind(taskExecutor);
  vi.spyOn(taskExecutor, "startExecution").mockImplementation(
    (task, resolvedAgent, activation) => {
      activationObservations.push({
        installed: task.executionActivation,
        received: activation,
      });
      return originalStartExecution(task, resolvedAgent, activation);
    },
  );
  const runtime = new TaskRuntimeCommands({
    agentRegistry: registry,
    taskManager,
    taskExecutor,
    logger,
  });

  return {
    runtime,
    taskManager,
    taskExecutor,
    persistenceDouble,
    autoResumeActivations,
    activationObservations,
    executeInputs,
  };
}

describe("UPSTREAM_TERMINAL_FOLLOWUP_ACTIVATION_RED", () => {
  it("forwards AutoResume's exact activation through upstream before acquiring and consuming", async () => {
    const harness = makeHarness();
    const task = await harness.taskManager.createTask({
      agentSessionId: "strict-red-session",
      prompt: "completed turn",
      profileId: agent.id,
    });
    task.status = "completed";
    task.completedAt = new Date("2026-08-27T00:00:00.000Z");
    task.terminalEventId = 7;
    task.lastEventId = 7;

    let runtimeError: string | null = null;
    try {
      await harness.runtime.intervene({
        agentSessionId: task.agentSessionId,
        text: "consume this terminal follow-up",
        user: "upstream",
      });
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error);
    }
    if (task.executionPromise) await task.executionPromise;

    const observation = harness.activationObservations.at(-1);
    const autoResumeActivation = harness.autoResumeActivations.at(-1);
    expect({
      signature: "UPSTREAM_TERMINAL_FOLLOWUP_ACTIVATION_RED",
      tokenCreated: autoResumeActivation !== undefined,
      installedTokenPreserved: observation?.installed === autoResumeActivation,
      tokenForwarded: observation?.received === autoResumeActivation,
      acquireCount:
        harness.persistenceDouble.acquireExecutionOwnershipAndWaitForApplication
          .mock.calls.length,
      consumedPrompts: harness.executeInputs.map((input) => input.prompt),
      pendingFollowups: task.interventionQueue.map((message) => message.text),
      runtimeError,
    }).toEqual({
      signature: "UPSTREAM_TERMINAL_FOLLOWUP_ACTIVATION_RED",
      tokenCreated: true,
      installedTokenPreserved: true,
      tokenForwarded: true,
      acquireCount: 1,
      consumedPrompts: ["consume this terminal follow-up"],
      pendingFollowups: [],
      runtimeError: null,
    });
  });
});
