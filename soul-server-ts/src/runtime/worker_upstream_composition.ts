import type { AgentConfigService } from "../agent_config_service.js";
import type { FileAttachmentStore } from "../attachments/file_manager.js";
import type { ClaudeAuthService } from "../auth/claude_auth.js";
import type { SessionDB } from "../db/session_db.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { RealtimeBroker } from "../realtime/realtime_broker.js";
import type { RunnerRecoveryCoordinator } from "../runner/runner_recovery_coordinator.js";
import type { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import { UpstreamAdapter } from "../upstream/adapter.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import {
  composeRunnerReconciliationReporter,
  type RunnerProcessComposition,
} from "./runner_process_composition.js";
import type { WorkerCompositionParams } from "./worker_composition_types.js";

interface WorkerUpstreamCompositionParams {
  worker: WorkerCompositionParams;
  taskManager: TaskManager;
  taskExecutor: TaskExecutor;
  attachmentStore: FileAttachmentStore;
  claudeAuth: ClaudeAuthService;
  sessionDb: SessionDB;
  realtimeBroker: RealtimeBroker;
  agentConfigService: AgentConfigService;
  reflectionRuntime: McpRuntime;
  scheduleCommands: SoulstreamScheduleService;
  modelCatalog: ModelCatalog;
  eventOutboxPump: EventOutboxPumpMux;
  runnerProcess: RunnerProcessComposition | undefined;
  runnerRecoveryCoordinator: RunnerRecoveryCoordinator | undefined;
}

export function composeWorkerUpstreamAdapter({
  worker,
  taskManager,
  taskExecutor,
  attachmentStore,
  claudeAuth,
  sessionDb,
  realtimeBroker,
  agentConfigService,
  reflectionRuntime,
  scheduleCommands,
  modelCatalog,
  eventOutboxPump,
  runnerProcess,
  runnerRecoveryCoordinator,
}: WorkerUpstreamCompositionParams): UpstreamAdapter {
  const { env, logger, agentRegistry, agentProfileSource } = worker;
  return new UpstreamAdapter(
    {
      url: env.SOULSTREAM_UPSTREAM_URL,
      nodeId: env.SOULSTREAM_NODE_ID,
      host: env.HOST,
      port: env.PORT,
      authBearerToken: env.AUTH_BEARER_TOKEN,
      userName: env.DASH_USER_NAME,
      userPortraitPath: env.DASH_USER_PORTRAIT,
      isProduction: env.ENVIRONMENT === "production",
      runnerProcessEnabled: env.SOUL_RUNNER_PROCESS_ENABLED,
      runnerLeaseTimeoutMs: env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
      ...(env.SOUL_RUNNER_STATE_DIR
        ? { runnerStateDir: env.SOUL_RUNNER_STATE_DIR }
        : {}),
      releaseActivationState: worker.releaseActivationState,
    },
    logger,
    {
      agentRegistry,
      taskManager,
      taskExecutor,
      attachmentStore,
      claudeAuth,
      sessionDb,
      realtimeBroker,
      agentConfigService,
      reflectionRuntime,
      scheduleCommands,
      deliveryV2Enabled: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
      modelCatalog,
      eventOutboxPump,
      ...composeRunnerReconciliationReporter(
        env,
        runnerProcess?.runtimeFactory,
        runnerRecoveryCoordinator,
        logger,
      ),
      ...(agentProfileSource ? { agentProfileSource } : {}),
    },
  );
}
