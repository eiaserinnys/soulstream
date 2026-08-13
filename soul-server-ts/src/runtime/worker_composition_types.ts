import type { AgentConfigService } from "../agent_config_service.js";
import type { AgentRegistry } from "../agent_registry.js";
import type { NewSessionAgentProfileSource } from "../agent_profile_source.js";
import type { FileAttachmentStore } from "../attachments/file_manager.js";
import type { ClaudeAuthService } from "../auth/claude_auth.js";
import type { Env } from "../config.js";
import type { ClaudeSessionClientRegistry } from "../engine/claude_session_client_registry.js";
import type { CodexCliPathResolution } from "../engine/codex_cli_path.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { McpConfigService } from "../mcp_config_service.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { ChecklistTaskAdapter } from "../page/checklist_task_adapter.js";
import type { ChecklistTaskReconciler } from "../page/checklist_task_reconciler.js";
import type { SessionPageBindingService } from "../page/session_page_binding_service.js";
import type { RealtimeBroker } from "../realtime/realtime_broker.js";
import type { RunnerRecoveryCoordinator } from "../runner/runner_recovery_coordinator.js";
import type { RunnerStateHostLock } from "../runner/runner_state_host_lock.js";
import type { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import type { ServerInstance } from "../server.js";
import type { TaskManager } from "../task/task_manager.js";
import type { EventOutbox } from "../upstream/event_outbox.js";
import type { EventOutboxPump } from "../upstream/event_outbox_pump.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import type { UpstreamAdapter } from "../upstream/adapter.js";
import type { SessionDB } from "../db/session_db.js";
import type { ClaudeRuntimeStartupRecovery } from "./claude_runtime_startup_recovery.js";
import type { TaskRuntimeComposition } from "./task_runtime_composition.js";
import type { NodeStallMonitor } from "./node_stall_monitor.js";

export interface WorkerCompositionParams {
  env: Env;
  logger: import("pino").Logger;
  agentRegistry: AgentRegistry;
  mcpConfigService: McpConfigService;
  codexCliPath?: CodexCliPathResolution;
  modelCatalog?: ModelCatalog;
  agentProfileSource?: NewSessionAgentProfileSource;
  nodeStallMonitor?: Pick<
    NodeStallMonitor,
    "beginRunnerOperation" | "sqliteTransactionObserver"
  >;
}

export interface WorkerComposition extends TaskRuntimeComposition {
  db: SessionDB;
  server: ServerInstance;
  taskManager: TaskManager;
  agentRegistry: AgentRegistry;
  agentProfileSource?: NewSessionAgentProfileSource;
  attachmentStore: FileAttachmentStore;
  claudeAuth: ClaudeAuthService;
  realtimeBroker: RealtimeBroker;
  agentConfigService: AgentConfigService;
  mcpRuntime: McpRuntime;
  scheduleService: SoulstreamScheduleService;
  sessionPageBindingService: SessionPageBindingService;
  checklistTaskAdapter: ChecklistTaskAdapter;
  checklistTaskReconciler: ChecklistTaskReconciler;
  claudeSessionClientRegistry?: ClaudeSessionClientRegistry;
  claudeRuntimeStartupRecovery?: ClaudeRuntimeStartupRecovery;
  eventOutbox: EventOutbox;
  eventOutboxPump: EventOutboxPump;
  eventOutboxPumpMux: EventOutboxPumpMux;
  runnerRecoveryCoordinator?: RunnerRecoveryCoordinator;
  runnerStateHostOwnership?: RunnerStateHostLock;
  createUpstreamAdapter(): UpstreamAdapter;
}
