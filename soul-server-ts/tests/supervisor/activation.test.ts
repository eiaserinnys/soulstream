import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB, SupervisorRegistryRow } from "../../src/db/session_db.js";
import {
  buildSupervisorBootPrompt,
  startConfiguredSupervisors,
  type SupervisorActivationConfig,
} from "../../src/supervisor/activation.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });
const role = "ariella-ashwood-codex";

const supervisorAgent: AgentProfile = {
  id: role,
  name: "아리엘라 애시우드",
  backend: "codex",
  workspace_dir: "/tmp/ariella",
};

const baseConfig: SupervisorActivationConfig = {
  enabled: true,
  roles: [role],
  folderId: "fa1a7018-6262-4452-b1e3-1f7e9c61d7d0",
};

function registryRow(overrides: Partial<SupervisorRegistryRow> = {}): SupervisorRegistryRow {
  const now = new Date("2026-06-07T00:00:00.000Z");
  return {
    role,
    activeSessionId: "supervisor-existing",
    epoch: 2,
    cursorOffset: 42,
    handoverState: "idle",
    cumulativeTokens: 10,
    compactionCount: 1,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTask(params: { sessionId: string; prompt: string }): Task {
  return {
    agentSessionId: params.sessionId,
    prompt: params.prompt,
    profileId: role,
    status: "running",
    createdAt: new Date("2026-06-07T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function createHarness(options: {
  registry?: SupervisorRegistryRow | null;
  sessionExists?: boolean;
  agents?: AgentProfile[];
} = {}) {
  const createdTasks: Task[] = [];
  const db = {
    getSupervisorRegistry: vi.fn(async () => options.registry ?? null),
    getSession: vi.fn(async () =>
      options.sessionExists
        ? {
            session_id: "supervisor-existing",
            agent_id: role,
            status: "completed",
            node_id: "eiaserinnys",
          }
        : null,
    ),
    upsertSupervisorRegistry: vi.fn(async (params) =>
      registryRow({
        role: params.role,
        activeSessionId: params.activeSessionId,
        epoch: params.epoch,
        cursorOffset: params.cursorOffset,
        handoverState: params.handoverState,
        cumulativeTokens: params.cumulativeTokens,
        compactionCount: params.compactionCount,
        lastSeenAt: params.lastSeenAt,
      }),
    ),
  } satisfies Partial<SessionDB>;
  const taskManager = {
    createTask: vi.fn(async (params) => {
      const task = makeTask({
        sessionId: params.agentSessionId,
        prompt: params.prompt,
      });
      createdTasks.push(task);
      return task;
    }),
    cancelTask: vi.fn(async () => true),
  } satisfies Partial<TaskManager>;
  const taskExecutor = {
    startExecution: vi.fn(),
  } satisfies Partial<TaskExecutor>;
  const agentRegistry = new AgentRegistry(options.agents ?? [supervisorAgent]);

  return {
    agentRegistry,
    createdTasks,
    db: db as SessionDB,
    taskExecutor: taskExecutor as TaskExecutor,
    taskManager: taskManager as TaskManager,
  };
}

describe("supervisor activation", () => {
  it("skips all startup work when disabled", async () => {
    const harness = createHarness();

    await expect(
      startConfiguredSupervisors({
        config: { ...baseConfig, enabled: false, roles: [] },
        agentRegistry: harness.agentRegistry,
        db: harness.db,
        taskManager: harness.taskManager,
        taskExecutor: harness.taskExecutor,
        logger: silentLogger,
      }),
    ).resolves.toEqual([{ role: "", status: "disabled" }]);

    expect(harness.db.getSupervisorRegistry).not.toHaveBeenCalled();
    expect(harness.taskManager.createTask).not.toHaveBeenCalled();
    expect(harness.taskExecutor.startExecution).not.toHaveBeenCalled();
  });

  it("keeps an existing active supervisor registry row", async () => {
    const harness = createHarness({
      registry: registryRow(),
      sessionExists: true,
    });

    await expect(
      startConfiguredSupervisors({
        config: baseConfig,
        agentRegistry: harness.agentRegistry,
        db: harness.db,
        taskManager: harness.taskManager,
        taskExecutor: harness.taskExecutor,
        logger: silentLogger,
      }),
    ).resolves.toEqual([{
      role,
      status: "existing",
      sessionId: "supervisor-existing",
    }]);

    expect(harness.db.getSession).toHaveBeenCalledWith("supervisor-existing");
    expect(harness.taskManager.createTask).not.toHaveBeenCalled();
    expect(harness.taskExecutor.startExecution).not.toHaveBeenCalled();
  });

  it("creates, registers, and starts a configured supervisor when missing", async () => {
    const harness = createHarness({ registry: null });

    await expect(
      startConfiguredSupervisors({
        config: baseConfig,
        agentRegistry: harness.agentRegistry,
        db: harness.db,
        taskManager: harness.taskManager,
        taskExecutor: harness.taskExecutor,
        logger: silentLogger,
        now: () => new Date("2026-06-07T01:02:03.000Z"),
        sessionIdFactory: () => "supervisor-ariella-1",
      }),
    ).resolves.toEqual([{
      role,
      status: "started",
      sessionId: "supervisor-ariella-1",
    }]);

    expect(harness.taskManager.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "supervisor-ariella-1",
        profileId: role,
        folderId: baseConfig.folderId,
        callerInfo: {
          source: "agent",
          display_name: "supervisor",
          agent_id: role,
          agent_name: "아리엘라 애시우드",
        },
      }),
    );
    expect(harness.createdTasks[0]?.prompt).toContain(
      `[supervisor bootstrap] role=${role}`,
    );
    expect(harness.db.upsertSupervisorRegistry).toHaveBeenCalledWith({
      role,
      activeSessionId: "supervisor-ariella-1",
      epoch: 0,
      cursorOffset: 0,
      handoverState: "idle",
      cumulativeTokens: 0,
      compactionCount: 0,
      lastSeenAt: new Date("2026-06-07T01:02:03.000Z"),
    });
    expect(harness.taskExecutor.startExecution).toHaveBeenCalledWith(
      harness.createdTasks[0],
      supervisorAgent,
    );
  });

  it("cancels the task and rolls back registry when startup fails after upsert", async () => {
    const harness = createHarness({ registry: null });
    vi.mocked(harness.taskExecutor.startExecution).mockImplementation(() => {
      throw new Error("engine factory boom");
    });

    await expect(
      startConfiguredSupervisors({
        config: baseConfig,
        agentRegistry: harness.agentRegistry,
        db: harness.db,
        taskManager: harness.taskManager,
        taskExecutor: harness.taskExecutor,
        logger: silentLogger,
        sessionIdFactory: () => "supervisor-ariella-1",
      }),
    ).rejects.toThrow("engine factory boom");

    expect(harness.taskManager.cancelTask).toHaveBeenCalledWith("supervisor-ariella-1");
    expect(harness.db.upsertSupervisorRegistry).toHaveBeenNthCalledWith(2, {
      role,
      activeSessionId: null,
      epoch: 0,
      cursorOffset: 0,
      handoverState: "idle",
      cumulativeTokens: 0,
      compactionCount: 0,
      lastSeenAt: null,
    });
  });

  it("fails fast when a configured supervisor role is missing from agents.yaml", async () => {
    const harness = createHarness({ agents: [] });

    await expect(
      startConfiguredSupervisors({
        config: baseConfig,
        agentRegistry: harness.agentRegistry,
        db: harness.db,
        taskManager: harness.taskManager,
        taskExecutor: harness.taskExecutor,
        logger: silentLogger,
      }),
    ).rejects.toThrow("Supervisor role not found in agents.yaml");

    expect(harness.taskManager.createTask).not.toHaveBeenCalled();
  });

  it("builds a deterministic boot prompt", () => {
    expect(buildSupervisorBootPrompt(role)).toContain(
      "Watch supervisor wake messages and decide whether action is needed.",
    );
  });
});
