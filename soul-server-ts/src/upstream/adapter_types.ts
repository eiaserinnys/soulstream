import type { AuthorizeOrchestrationWorker } from "./task_runtime_commands.js";
import type { AgentConfigService } from "../agent_config_service.js";
import type { NewSessionAgentProfileSource } from "../agent_profile_source.js";
import type { AgentRegistry } from "../agent_registry.js";
import type { AttachmentStore } from "../attachments/file_manager.js";
import type { ClaudeAuthCommandHandler } from "../auth/claude_auth.js";
import type { SessionDB } from "../db/session_db.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { RealtimeBroker } from "../realtime/realtime_broker.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { ClaudeRuntimeScheduleCommands } from "./claude_runtime_commands.js";
import type { EventOutboxPumpTransport } from "./event_outbox_pump.js";
import type { ReleaseActivationState } from "../release/release_activation_state.js";
import type { WorktreeService } from "../worktree/worktree_service.js";
import type { PurposeDecisionRunner } from "../card-orchestration/purpose_runner.js";

export interface UpstreamConfig {
  url: string;
  nodeId: string;
  host: string;
  port: number;
  authBearerToken: string;
  userName: string;
  userPortraitPath: string;
  isProduction: boolean;
  runnerProcessEnabled?: boolean;
  worktreeMcpEnabled?: boolean;
  runnerStateDir?: string;
  heartbeatIntervalMs?: number;
  heartbeatMaxMissed?: number;
  releaseActivationState?: ReleaseActivationState;
}

export interface UpstreamDependencies {
  agentRegistry: AgentRegistry;
  taskManager: TaskManager;
  taskExecutor: TaskExecutor;
  attachmentStore?: AttachmentStore;
  claudeAuth?: ClaudeAuthCommandHandler;
  sessionDb?: SessionDB;
  realtimeBroker?: RealtimeBroker;
  agentConfigService?: AgentConfigService;
  reflectionRuntime?: McpRuntime;
  scheduleCommands?: ClaudeRuntimeScheduleCommands;
  modelCatalog?: Pick<ModelCatalog, "resolve" | "advertise" | "list">;
  eventOutboxPump?: EventOutboxPumpTransport;
  agentProfileSource?: NewSessionAgentProfileSource;
  listLiveRunnerSessionIds?: () => Promise<string[]>;
  waitForRunnerReconciliation?: () => Promise<void>;
  reconnectPolicy?: ReconnectPolicyBoundary;
  worktreeService?: WorktreeService;
  decisionRunner?: Pick<PurposeDecisionRunner, "create" | "cancel" | "prepare">;
  authorizeOrchestrationWorker?: AuthorizeOrchestrationWorker;
}

export interface ReconnectPolicyBoundary {
  readonly attempt: number;
  readonly currentDelaySeconds: number;
  reset(): void;
  wait(): Promise<void>;
}
