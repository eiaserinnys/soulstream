import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { Env } from "../config.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type {
  EngineFactory,
  RunnerProcessRuntimeFactory,
} from "../task/task_executor.js";
import { TaskExecutor } from "../task/task_executor.js";
import { ExecutionOwnershipBackoff } from "../task/execution_ownership_backoff.js";
import {
  TaskCompletionNotifier,
  type CompletionNotifier,
} from "../task/completion_notifier.js";
import { CompletionDeliveryRecoveryWorker } from
  "../task/completion_delivery_recovery_worker.js";
import { ClaudeRuntimeTaskFollowupController } from
  "../task/claude_runtime_task_followup.js";
import type { StartExecutionCallback, TaskManager } from "../task/task_manager.js";
import type { TransientEventLogAggregator } from
  "../task/transient_event_log_aggregator.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import { ScheduleDispatcher } from "../schedule/schedule_dispatcher.js";
import type { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

export interface TaskRuntimeCompositionParams {
  env: Env;
  db: SessionDB;
  logger: Logger;
  agentRegistry: AgentRegistry;
  taskManager: TaskManager;
  engineFactory: EngineFactory;
  modelCatalog: Pick<ModelCatalog, "resolve">;
  contextBuilder: ExecutionContextBuilder;
  persistence: EventPersistence;
  broadcaster: SessionBroadcaster;
  scheduleService: SoulstreamScheduleService;
  orchProxyConfig: OrchProxyConfig;
  runnerProcessFactory?: RunnerProcessRuntimeFactory;
  transientEventLogAggregator: TransientEventLogAggregator;
}

export interface TaskRuntimeComposition {
  taskExecutor: TaskExecutor;
  completionNotifier: CompletionNotifier;
  completionDeliveryRecoveryWorker?: CompletionDeliveryRecoveryWorker;
  executionOwnershipBackoff: ExecutionOwnershipBackoff;
  onResume: StartExecutionCallback;
  scheduleDispatcher: ScheduleDispatcher;
  claudeRuntimeTaskFollowup: Pick<
    ClaudeRuntimeTaskFollowupController,
    "collectDetached"
  >;
}

/** Owns task execution, completion delivery, scheduling, and resume wiring. */
export function composeTaskRuntime(
  params: TaskRuntimeCompositionParams,
): TaskRuntimeComposition {
  const {
    env,
    db,
    logger,
    agentRegistry,
    taskManager,
    engineFactory,
    modelCatalog,
    runnerProcessFactory,
    contextBuilder,
    persistence,
    broadcaster,
    scheduleService,
    orchProxyConfig,
    transientEventLogAggregator,
  } = params;
  // Owned here because the executor is where conflicts are observed; the
  // runner recovery scan borrows the same instance to honour the backoff.
  const executionOwnershipBackoff = new ExecutionOwnershipBackoff({ logger });
  let taskExecutor: TaskExecutor;
  const onResume: StartExecutionCallback = (task, activation) => {
    if (!task.profileId) {
      throw new Error(`Cannot auto-resume ${task.agentSessionId}: task is missing profileId`);
    }
    const agent = task.agentProfileSnapshot ?? agentRegistry.get(task.profileId);
    if (!agent) {
      throw new Error(
        `Cannot auto-resume ${task.agentSessionId}: unknown agent profile ${task.profileId}`,
      );
    }
    return taskExecutor.startExecution(task, agent, activation);
  };

  const completionDeliveryRepository = env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
    ? db.sessionDeliveries()
    : undefined;
  const notificationRecoveryLeaseOwner = env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
    ? `notification:${env.SOULSTREAM_NODE_ID}:${randomUUID()}`
    : undefined;
  const completionNotifier = new TaskCompletionNotifier(
    env.SOULSTREAM_NODE_ID,
    taskManager,
    agentRegistry,
    onResume,
    logger,
    orchProxyConfig,
    undefined,
    db,
    env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
    completionDeliveryRepository,
  );
  const completionDeliveryRecoveryWorker = env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
    ? new CompletionDeliveryRecoveryWorker({
        recoverPending: () => completionNotifier.recoverPending(),
        recoverNotifications: async () => {
          await taskManager.recoverDeliveryNotifications(
            notificationRecoveryLeaseOwner!,
          );
        },
        logger,
      })
    : undefined;
  const claudeRuntimeTaskFollowup = new ClaudeRuntimeTaskFollowupController({
    taskManager,
    onResume,
    releaseRetainedRunner: async (task) =>
      await taskExecutor.releaseRetainedClaudeRunner(task),
    logger,
    deliveryV2Enabled: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
    inlineConsumptionRecorder: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
      ? taskManager.getDeliveryConsumptionRecorder()
      : undefined,
    pendingSupersessionRecorder: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
      ? taskManager.getDeliveryConsumptionRecorder()
      : undefined,
  });

  taskExecutor = new TaskExecutor(
    engineFactory,
    db,
    persistence,
    broadcaster,
    logger,
    contextBuilder,
    completionNotifier,
    scheduleService.makeToolHandler(),
    claudeRuntimeTaskFollowup,
    env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
      ? taskManager.getDeliveryConsumptionRecorder()
      : undefined,
    modelCatalog,
    runnerProcessFactory,
    transientEventLogAggregator,
    executionOwnershipBackoff,
    env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
  );
  completionDeliveryRecoveryWorker?.start();
  const scheduleDispatcher = new ScheduleDispatcher(
    { nodeId: env.SOULSTREAM_NODE_ID },
    scheduleService,
    taskManager,
    onResume,
    logger,
  );
  scheduleDispatcher.start();

  return {
    taskExecutor,
    completionNotifier,
    completionDeliveryRecoveryWorker,
    executionOwnershipBackoff,
    onResume,
    scheduleDispatcher,
    claudeRuntimeTaskFollowup,
  };
}
