import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { ClaudeAuthCommandHandler } from "../auth/claude_auth.js";
import {
  ProviderUsageService,
  type ProviderUsageCommandHandler,
} from "../auth/provider_usage.js";
import {
  FileAttachmentStore,
  type AttachmentStore,
} from "../attachments/file_manager.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { SessionDB } from "../db/session_db.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { RealtimeBroker } from "../realtime/realtime_broker.js";
import { SupervisorDirectTargetGuard } from "../supervisor/direct_target_guard.js";
import {
  AgentConfigCommands,
  type AgentConfigCommandHandler,
} from "./agent_config_commands.js";
import { createAgentConfigCommandFamily } from "./agent_config_command_family.js";
import { AttachmentCommands } from "./attachment_commands.js";
import { createAttachmentCommandFamily } from "./attachment_command_family.js";
import { ClaudeAuthCommands } from "./claude_auth_commands.js";
import { createAuthCommandFamily } from "./auth_command_family.js";
import {
  ClaudeRuntimeCommands,
  type ClaudeRuntimeScheduleCommands,
} from "./claude_runtime_commands.js";
import { createClaudeRuntimeCommandFamily } from "./claude_runtime_command_family.js";
import {
  CommandDispatchError,
  type CommandHandlerMap,
  type CommandLike,
  type SendFn,
} from "./command_family.js";
import { DeliveryCommands } from "./delivery_commands.js";
import { createHealthCommandFamily } from "./health_command_family.js";
import { createInterventionCommandFamily } from "./intervention_command_family.js";
import { ProviderUsageCommands } from "./provider_usage_commands.js";
import {
  buildRealtimeAckError,
  type RealtimeAckType,
} from "./realtime_ack.js";
import { RealtimeCommands } from "./realtime_commands.js";
import {
  RealtimeCommandDispatchError,
  createRealtimeCommandFamily,
} from "./realtime_command_family.js";
import { ReflectionCommands } from "./reflection_commands.js";
import { createReflectionCommandFamily } from "./reflection_command_family.js";
import { SessionListCommands } from "./session_list_commands.js";
import { createSessionCommandFamily } from "./session_command_family.js";
import { TaskRuntimeCommands } from "./task_runtime_commands.js";

export type { SendFn } from "./command_family.js";

/**
 * orch → 노드 명령 디스패처.
 *
 * `handlers` is the command inventory. Command-specific adaptation lives in
 * family modules; this class owns raw command routing and error envelopes.
 *
 * Cross-runtime parity to preserve here:
 * - command ACK correlation uses `requestId`, not `request_id`
 * - commands without requestId may perform side effects but emit no ACK
 * - `subscribe_events` is accepted without ACK; TS already broadcasts task
 *   events through `broadcaster.emitEventEnvelope`, while Python starts a
 *   relay loop for its different event-channel shape
 */
export class CommandDispatcher {
  private readonly handlers: CommandHandlerMap;

  constructor(
    private readonly send: SendFn,
    private readonly logger: Logger,
    nodeId: string,
    agentRegistry: AgentRegistry,
    taskManager: TaskManager,
    taskExecutor: TaskExecutor,
    attachmentStore: AttachmentStore = new FileAttachmentStore(".local/incoming", logger),
    claudeAuth?: ClaudeAuthCommandHandler,
    /**
     * `list_sessions` needs SessionDB. Keep it optional at construction so
     * missing wiring becomes an explicit command error instead of a silent
     * fallback.
     */
    sessionDb?: SessionDB,
    realtimeBroker?: RealtimeBroker,
    providerUsage?: ProviderUsageCommandHandler,
    agentConfigService?: AgentConfigCommandHandler,
    reflectionRuntime?: McpRuntime,
    scheduleCommands?: ClaudeRuntimeScheduleCommands,
  ) {
    const taskRuntimeCommands = new TaskRuntimeCommands({
      agentRegistry,
      taskManager,
      taskExecutor,
      logger,
    });
    const supervisorDirectTargetGuard = sessionDb
      ? new SupervisorDirectTargetGuard({ db: sessionDb, taskManager })
      : undefined;
    const attachmentCommands = new AttachmentCommands(attachmentStore);
    const sessionListCommands = new SessionListCommands(sessionDb, nodeId);
    const claudeAuthCommands = new ClaudeAuthCommands({ agentRegistry, claudeAuth });
    const providerUsageCommands = new ProviderUsageCommands({
      providerUsage: providerUsage ?? new ProviderUsageService({ claudeAuth }),
    });
    const deliveryCommands = new DeliveryCommands({
      agentRegistry,
      taskManager,
      taskExecutor,
      logger,
    });
    const claudeRuntimeCommands = new ClaudeRuntimeCommands(
      taskManager,
      scheduleCommands,
    );
    const realtimeCommands = new RealtimeCommands(realtimeBroker);
    const agentConfigCommands = new AgentConfigCommands(
      agentConfigService,
      agentRegistry,
    );
    const reflectionCommands = new ReflectionCommands(reflectionRuntime);

    this.handlers = {
      ...createHealthCommandFamily({ send, nodeId, agentRegistry, taskManager }),
      ...createSessionCommandFamily({
        send,
        logger,
        taskManager,
        taskRuntimeCommands,
        sessionListCommands,
      }),
      ...createInterventionCommandFamily({
        send,
        deliveryCommands,
        taskRuntimeCommands,
        supervisorDirectTargetGuard,
      }),
      ...createClaudeRuntimeCommandFamily({ send, claudeRuntimeCommands }),
      ...createRealtimeCommandFamily({ send, realtimeCommands }),
      ...createAttachmentCommandFamily({ send, attachmentCommands }),
      ...createAuthCommandFamily({
        send,
        claudeAuthCommands,
        providerUsageCommands,
      }),
      ...createReflectionCommandFamily({ send, reflectionCommands }),
      ...createAgentConfigCommandFamily({ send, agentConfigCommands }),
    };
  }

  async dispatch(rawCmd: unknown): Promise<void> {
    const cmd = (rawCmd ?? {}) as CommandLike;
    if (!cmd.type) {
      this.logger.warn({ cmd }, "Upstream command without type — ignoring");
      return;
    }
    const handler = this.handlers[cmd.type];
    if (handler) {
      try {
        await handler(cmd);
      } catch (err) {
        if (err instanceof CommandDispatchError) {
          await this.sendError(cmd, err.message);
          return;
        }
        if (err instanceof RealtimeCommandDispatchError) {
          await this.sendRealtimeAckError(
            err.ackType,
            err.requestId,
            err.agentSessionId,
            err.message,
          );
          return;
        }
        this.logger.error({ err, cmdType: cmd.type }, "Handler threw");
        await this.sendError(cmd, `Handler error: ${stringifyError(err)}`);
      }
    } else {
      await this.sendError(
        cmd,
        `Not implemented in soul-server-ts: ${cmd.type}`,
      );
    }
  }

  private async sendError(cmd: CommandLike, message: string): Promise<void> {
    await this.send({
      type: "error",
      message,
      requestId: cmd.requestId ?? cmd.request_id ?? "",
      command_type: cmd.type ?? "",
    });
    this.logger.warn({ cmd, message }, "Sent error to upstream");
  }

  private async sendRealtimeAckError(
    type: RealtimeAckType,
    requestId: string,
    agentSessionId: string,
    message: string,
  ): Promise<void> {
    if (!requestId) return;
    await this.send(
      buildRealtimeAckError({
        type,
        requestId,
        agentSessionId,
        message,
      }),
    );
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
