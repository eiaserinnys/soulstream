import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import pino from "pino";
import { vi } from "vitest";

import { composeTaskRuntime } from "../../src/runtime/task_runtime_composition.js";
import { composeWorkerRuntime } from "../../src/runtime/worker_composition.js";
import { composeChecklistTaskProjection } from "../../src/runtime/checklist_task_composition.js";
import { parseEnv } from "../../src/config.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { Task } from "../../src/task/task_models.js";
import type { TaskManager } from "../../src/task/task_manager.js";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

function source(relativePath: string): string {
  return readFileSync(`${sourceRoot}${relativePath}`, "utf8");
}

describe("worker composition boundary", () => {
  it("exports explicit worker and task composition roots", () => {
    expect(composeWorkerRuntime).toBeTypeOf("function");
    expect(composeTaskRuntime).toBeTypeOf("function");
  });

  it("keeps process lifecycle in main and dependency construction in composition modules", () => {
    const main = source("main.ts");
    const workerComposition = source("runtime/worker_composition.ts");
    const taskComposition = source("runtime/task_runtime_composition.ts");

    expect(main).toContain("composeWorkerRuntime");
    expect(main).toContain('process.once("SIGTERM"');
    expect(main).not.toMatch(/new (SessionDB|TaskManager|TaskExecutor|TaskService)\b/);
    expect(workerComposition).toMatch(/new (SessionDB|TaskManager|TaskService)\b/);
    expect(taskComposition).toContain("new TaskExecutor");
  });

  it("loads the model catalog at startup and warns only profiles missing default_preset", () => {
    const main = source("main.ts");

    expect(main).toContain("loadModelCatalog(env.MODEL_CATALOG_PATH, logger)");
    expect(main).toContain("Failed to load model catalog");
    expect(main).toContain("if (!profile.default_preset)");
    expect(main).not.toContain("if (profile.default_preset) {");
  });

  it("reuses the task model preset fallback resolver at the upstream boundary", () => {
    const runtimeCommands = source("upstream/task_runtime_commands.ts");

    expect(runtimeCommands).toContain("resolveModelPresetSelection(");
    expect(runtimeCommands).not.toContain("private resolvePreset(");
  });

  it("wires durable page ancestry through the existing orch host client", () => {
    const workerComposition = source("runtime/worker_composition.ts");

    expect(workerComposition).toContain("new HostPageContextRepository");
    expect(workerComposition).toContain("new AncestorPageContextResolver");
    expect(workerComposition).toContain("new DefaultPageContextAssembler");
    expect(workerComposition).not.toContain("NO_PAGE_ANCHOR_CONTEXT_RESOLVER");
  });

  it("exports an executable checklist projection composition boundary", () => {
    expect(composeChecklistTaskProjection).toBeTypeOf("function");
  });

  it("production task composition keeps gate-OFF completion delivery DB-free and legacy-local", async () => {
    const env = parseEnv({
      SOULSTREAM_NODE_ID: "node-test",
      SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
      DATABASE_URL: "postgres://test:test@localhost:5432/soulstream_test",
      CLAUDE_SESSION_RUNTIME_V2_ENABLED: "false",
    });
    const getSession = vi.fn(async () => {
      throw new Error("gate-off completion delivery must not touch SessionDB");
    });
    const sessionDeliveries = vi.fn(() => {
      throw new Error("gate-off completion delivery must not create its repository");
    });
    const db = {
      getSession,
      sessionDeliveries,
    } as unknown as SessionDB;
    const addIntervention = vi.fn().mockResolvedValue({
      queued: true,
      queuePosition: 1,
    });
    const getDeliveryConsumptionRecorder = vi.fn();
    const taskManager = {
      addIntervention,
      getDeliveryConsumptionRecorder,
    } as unknown as TaskManager;
    const scheduleService = {
      makeToolHandler: vi.fn(() => vi.fn()),
      touchNodeHeartbeat: vi.fn().mockResolvedValue(undefined),
      repairExpiredClaims: vi.fn().mockResolvedValue([]),
      restoreOrphanSchedulesForLiveNodes: vi.fn().mockResolvedValue([]),
      markOrphanDueSchedules: vi.fn().mockResolvedValue([]),
      claimDueSchedules: vi.fn().mockResolvedValue([]),
      consumeClaimedSchedule: vi.fn(),
      confirmScheduleStillFiring: vi.fn(),
      deferDispatch: vi.fn(),
      finishDispatch: vi.fn(),
      failDispatch: vi.fn(),
    };
    const composition = composeTaskRuntime({
      env,
      db,
      logger: pino({ level: "silent" }),
      agentRegistry: { get: vi.fn() } as never,
      taskManager,
      engineFactory: vi.fn() as never,
      modelCatalog: { resolve: vi.fn() } as never,
      contextBuilder: {} as never,
      persistence: {} as never,
      broadcaster: {} as never,
      scheduleService: scheduleService as never,
      orchProxyConfig: {
        baseUrl: "http://localhost:5200",
        headers: {},
      },
    });

    try {
      await composition.completionNotifier.notify({
        agentSessionId: "child-session",
        prompt: "child work",
        status: "completed",
        profileId: "child-agent",
        callerSessionId: "caller-session",
        createdAt: new Date("2026-07-26T00:00:00.000Z"),
        completedAt: new Date("2026-07-26T00:01:00.000Z"),
        lastEventId: 3,
        lastReadEventId: 0,
        lastAssistantText: "finished",
        interventionQueue: [],
      } satisfies Task);

      expect(env.CLAUDE_SESSION_RUNTIME_V2_ENABLED).toBe(false);
      expect(getSession).not.toHaveBeenCalled();
      expect(sessionDeliveries).not.toHaveBeenCalled();
      expect(getDeliveryConsumptionRecorder).not.toHaveBeenCalled();
      expect(addIntervention).toHaveBeenCalledTimes(1);
      expect(addIntervention.mock.calls[0]![0]).not.toHaveProperty("deliveryId");
      expect(composition.completionDeliveryRecoveryWorker).toBeUndefined();
    } finally {
      composition.scheduleDispatcher.stop();
    }
  });

  it("keeps gate-OFF intervention wiring free of feature-only awaits", () => {
    const taskManager = source("task/task_manager.ts");
    const taskExecutor = source("task/task_executor.ts");
    const interventionRoute = source("task/task_intervention_route.ts");
    const lifecycleRoute = source("task/task_lifecycle_route.ts");
    const workerComposition = source("runtime/worker_composition.ts");

    expect(taskManager).toMatch(
      /deliveryLedgerGate: deliveryRuntimeV2Enabled\s+\? this\.deliveryLedgerGate\s+: undefined/,
    );
    expect(taskManager).toMatch(
      /sessionNotificationPublisher: deliveryRuntimeV2Enabled\s+\? this\.sessionNotificationPublisher\s+: undefined/,
    );
    expect(taskManager).toMatch(
      /const gatedSessionRuntimeControl = deliveryRuntimeV2Enabled\s+\?\s+sessionRuntimeControl\s+:\s+undefined/,
    );
    expect(interventionRoute).not.toMatch(
      /await this\.deps\.(deliveryLedgerGate|sessionNotificationPublisher)\?\./,
    );
    expect(lifecycleRoute).toContain(
      "if (!this.deps.closeSessionRuntime) return false;",
    );
    expect(lifecycleRoute).not.toMatch(
      /await this\.deps\.closeSessionRuntime\?\./,
    );
    expect(workerComposition).toMatch(
      /const claudeRuntime = env\.CLAUDE_SESSION_RUNTIME_V2_ENABLED\s+\?\s+await composeClaudeRuntime\(/,
    );
    expect(workerComposition).toMatch(
      /:\s+\{\};\s+const claudeSessionClientRegistry = claudeRuntime\.registry/,
    );
    expect(taskExecutor).toMatch(
      /const turnReceipt = this\.deliveryConsumption\s+\?\s+new TaskDeliveryTurnReceipt\(/,
    );
    expect(taskExecutor).toContain(
      "if (turnReceipt) await turnReceipt.observe(task, event);",
    );
    expect(taskExecutor).toContain(
      "if (!followupStalled && turnReceipt) await turnReceipt.consume(task);",
    );
    expect(taskExecutor).not.toMatch(
      /(?<!if \(turnReceipt\) )await turnReceipt\.observe\(/,
    );
    expect(taskExecutor).not.toMatch(
      /(?<!if \(!followupStalled && turnReceipt\) )await turnReceipt\.consume\(/,
    );
  });

  it("starts delivery recovery only after the crash-resume executor is bound", () => {
    const taskComposition = source("runtime/task_runtime_composition.ts");
    const executorIndex = taskComposition.indexOf(
      "taskExecutor = new TaskExecutor(",
    );
    const recoveryIndex = taskComposition.indexOf(
      "completionDeliveryRecoveryWorker?.start();",
    );

    expect(executorIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeGreaterThan(executorIndex);
  });

  it("fails closed on runtime schema before startup cleanup or index work", () => {
    const workerComposition = source("runtime/worker_composition.ts");
    const preflightIndex = workerComposition.indexOf(
      "await preflightPersistentRuntimeSchema(",
    );
    const indexEnsureIndex = workerComposition.indexOf(
      "ensureStableSessionOrderIndexInBackground(db, logger);",
    );
    const cleanupIndex = workerComposition.indexOf(
      "await db.interruptRunningSessionsForNode(",
    );

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(indexEnsureIndex).toBeGreaterThan(preflightIndex);
    expect(cleanupIndex).toBeGreaterThan(preflightIndex);
  });

  it("keeps every production module touched by the extraction below 500 lines", () => {
    const files = [
      "main.ts",
      "runtime/worker_composition.ts",
      "runtime/worker_schema_preflight.ts",
      "runtime/task_runtime_composition.ts",
      "context/context_builder.ts",
      "context/context_builder_helpers.ts",
      "context/page_context_resolver.ts",
      "context/page_context_repository.ts",
      "context/page_context_assembler.ts",
      "page/checklist_task_adapter.ts",
      "page/checklist_task_projection_repository.ts",
      "page/checklist_task_reconciler.ts",
      "runtime/checklist_task_composition.ts",
      "work-task/task_service.ts",
      "task/task_creation.ts",
      "task/task_creation_hook.ts",
      "engine/claude_sdk_client.ts",
      "engine/claude_sdk_legacy_pump.ts",
      "engine/claude_sdk_event_mapper.ts",
      "engine/claude_sdk_background_membership_mapper.ts",
      "engine/claude_sdk_persistent_session.ts",
      "engine/claude_persistent_background_lifecycle.ts",
      "engine/claude_session_client_registry.ts",
      "engine/claude_session_runtime.ts",
      "task/task_claude_runtime_control_route.ts",
      "task/completion_delivery_coordinator.ts",
      "task/completion_delivery_recovery_worker.ts",
      "task/completion_notifier.ts",
      "task/queued_delivery_transcript_recovery.ts",
      "db/repositories/session_delivery_repository.ts",
      "db/repositories/session_delivery_recovery_repository.ts",
      "db/repositories/session_delivery_relation_repository.ts",
      "db/runtime_schema_preflight.ts",
      "engine/claude_delivery_transcript_receipt.ts",
    ];

    for (const file of files) {
      const lineCount = source(file).split("\n").length;
      expect(lineCount, file).toBeLessThanOrEqual(500);
    }
  });
});
