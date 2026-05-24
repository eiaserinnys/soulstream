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
import type { ContextItem } from "../context/prompt_assembler.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { CallerInfo, Task } from "../task/task_models.js";
import type { ReasoningEffort } from "../engine/protocol.js";
import type { SessionDB } from "../db/session_db.js";
import type { RealtimeBroker } from "../realtime/realtime_broker.js";
import {
  AttachmentCommandError,
  AttachmentCommands,
} from "./attachment_commands.js";
import {
  ClaudeAuthCommandError,
  ClaudeAuthCommands,
  type ClaudeAuthCommand,
} from "./claude_auth_commands.js";
import {
  DeliveryCommandError,
  DeliveryCommands,
  type RespondCommand,
  type ToolApprovalCommand,
} from "./delivery_commands.js";
import {
  buildRealtimeAckError,
  type RealtimeAckType,
} from "./realtime_ack.js";
import {
  ProviderUsageCommandError,
  ProviderUsageCommands,
  type ProviderUsageCommand,
} from "./provider_usage_commands.js";
import {
  RealtimeCommandError,
  RealtimeCommands,
  type RealtimeCommandAck,
  type RealtimeCreateCallCommand,
  type RealtimeEventCommand,
  type RealtimeResolveToolApprovalCommand,
} from "./realtime_commands.js";
import {
  SessionListCommandError,
  SessionListCommands,
} from "./session_list_commands.js";
import {
  TaskRuntimeCommands,
  UnknownAgentProfileError,
  buildInterveneAck,
  buildSessionCreatedAck,
} from "./task_runtime_commands.js";

export type SendFn = (data: unknown) => Promise<void>;

interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

interface CreateSessionCmd extends CommandLike {
  type: "create_session";
  agentSessionId: string;
  prompt: string;
  profile?: string;
  caller_session_id?: string | null;
  caller_info?: CallerInfo;
  attachment_paths?: string[];
  extra_context_items?: ContextItem[];
  model?: string | null;
  oauth_token?: string | null;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  use_mcp?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  useMcp?: boolean;
  reasoningEffort?: ReasoningEffort;
  folderId?: string | null;
  /**
   * Python parity: upstream `systemPrompt` forwards into the session's
   * system_prompt without renaming on the wire.
   */
  systemPrompt?: string;
}

interface IntervenCmd extends CommandLike {
  type: "intervene";
  agentSessionId?: string;
  session_id?: string;
  text: string;
  user?: string;
  caller_info?: CallerInfo;
  attachment_paths?: string[];
}

interface InterruptSessionCmd extends CommandLike {
  type: "interrupt_session";
  agentSessionId?: string;
  session_id?: string;
}

interface SubscribeEventsCmd extends CommandLike {
  type: "subscribe_events";
  agentSessionId?: string;
  session_id?: string;
  subscribeId?: string;
}

interface UploadAttachmentCmd extends CommandLike {
  type: "upload_attachment";
  session_id?: string;
  filename?: string;
  content_type?: string;
  content_b64?: string;
}

interface DeleteSessionAttachmentsCmd extends CommandLike {
  type: "delete_session_attachments";
  session_id?: string;
}

interface DownloadAttachmentCmd extends CommandLike {
  type: "download_attachment";
  path?: string;
}

type ListSessionsCmd = CommandLike & { type: "list_sessions" };

/**
 * orch → 노드 명령 디스패처.
 *
 * `handlers` is the command inventory. Keep route-specific policy in the
 * boundary collaborators; this class owns raw command routing, send gating,
 * and generic error envelopes.
 *
 * Cross-runtime parity to preserve here:
 * - command ACK correlation uses `requestId`, not `request_id`
 * - commands without requestId may perform side effects but emit no ACK
 * - `subscribe_events` is accepted without ACK; TS already broadcasts task
 *   events through `broadcaster.emitEventEnvelope`, while Python starts a
 *   relay loop for its different event-channel shape
 */
export class CommandDispatcher {
  private readonly handlers: Record<string, (cmd: CommandLike) => Promise<void>>;
  private readonly taskRuntimeCommands: TaskRuntimeCommands;
  private readonly attachmentCommands: AttachmentCommands;
  private readonly sessionListCommands: SessionListCommands;
  private readonly claudeAuthCommands: ClaudeAuthCommands;
  private readonly providerUsageCommands: ProviderUsageCommands;
  private readonly deliveryCommands: DeliveryCommands;
  private readonly realtimeCommands: RealtimeCommands;

  constructor(
    private readonly send: SendFn,
    private readonly logger: Logger,
    private readonly nodeId: string,
    private readonly agentRegistry: AgentRegistry,
    private readonly taskManager: TaskManager,
    private readonly taskExecutor: TaskExecutor,
    private readonly attachmentStore: AttachmentStore = new FileAttachmentStore(".local/incoming"),
    claudeAuth?: ClaudeAuthCommandHandler,
    /**
     * `list_sessions` needs SessionDB. Keep it optional at construction so
     * missing wiring becomes an explicit command error instead of a silent
     * fallback.
     */
    sessionDb?: SessionDB,
    realtimeBroker?: RealtimeBroker,
    providerUsage?: ProviderUsageCommandHandler,
  ) {
    this.taskRuntimeCommands = new TaskRuntimeCommands({
      agentRegistry,
      taskManager,
      taskExecutor,
      logger,
    });
    this.attachmentCommands = new AttachmentCommands(attachmentStore);
    this.sessionListCommands = new SessionListCommands(sessionDb);
    this.claudeAuthCommands = new ClaudeAuthCommands({ agentRegistry, claudeAuth });
    this.providerUsageCommands = new ProviderUsageCommands({
      providerUsage: providerUsage ?? new ProviderUsageService({ claudeAuth }),
    });
    this.deliveryCommands = new DeliveryCommands({
      agentRegistry,
      taskManager,
      taskExecutor,
      logger,
    });
    this.realtimeCommands = new RealtimeCommands(realtimeBroker);
    // This table is the route inventory. Add new command types here, then put
    // command-specific adaptation behind a tested boundary when it has depth.
    this.handlers = {
      health_check: (cmd) => this.handleHealthCheck(cmd),
      create_session: (cmd) => this.handleCreateSession(cmd as CreateSessionCmd),
      intervene: (cmd) => this.handleIntervene(cmd as IntervenCmd),
      interrupt_session: (cmd) => this.handleInterruptSession(cmd as InterruptSessionCmd),
      respond: (cmd) => this.handleRespond(cmd as RespondCommand),
      approve_tool: (cmd) => this.handleToolApproval(cmd as ToolApprovalCommand),
      reject_tool: (cmd) => this.handleToolApproval(cmd as ToolApprovalCommand),
      realtime_create_call: (cmd) =>
        this.handleRealtimeCreateCall(cmd as RealtimeCreateCallCommand),
      realtime_event: (cmd) =>
        this.handleRealtimeEvent(cmd as RealtimeEventCommand),
      realtime_resolve_tool_approval: (cmd) =>
        this.handleRealtimeResolveToolApproval(cmd as RealtimeResolveToolApprovalCommand),
      subscribe_events: (cmd) => this.handleSubscribeEvents(cmd as SubscribeEventsCmd),
      list_sessions: (cmd) => this.handleListSessions(cmd as ListSessionsCmd),
      upload_attachment: (cmd) => this.handleUploadAttachment(cmd as UploadAttachmentCmd),
      delete_session_attachments: (cmd) =>
        this.handleDeleteSessionAttachments(cmd as DeleteSessionAttachmentsCmd),
      download_attachment: (cmd) =>
        this.handleDownloadAttachment(cmd as DownloadAttachmentCmd),
      claude_auth_status: (cmd) => this.handleClaudeAuth(cmd as ClaudeAuthCommand),
      claude_auth_set_token: (cmd) => this.handleClaudeAuth(cmd as ClaudeAuthCommand),
      claude_auth_delete_token: (cmd) => this.handleClaudeAuth(cmd as ClaudeAuthCommand),
      claude_auth_get_usage: (cmd) => this.handleClaudeAuth(cmd as ClaudeAuthCommand),
      claude_auth_get_profile: (cmd) => this.handleClaudeAuth(cmd as ClaudeAuthCommand),
      provider_usage_get: (cmd) =>
        this.handleProviderUsage(cmd as ProviderUsageCommand),
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

  /**
   * `respond` 명령 — Claude AskUserQuestion/input_request 응답.
   *
   * wire에는 두 ID가 공존한다:
   * - requestId: orch command ACK 매칭용 ID
   * - inputRequestId/request_id: Claude pending input request ID
   *
   * DeliveryCommands owns validation and ACK shape. Dispatcher only sends the
   * returned ACK or maps boundary validation failures to the generic error wire.
   */
  private async handleRespond(cmd: RespondCommand): Promise<void> {
    try {
      const ack = await this.deliveryCommands.respond(cmd);
      if (ack) {
        await this.send(ack);
      }
    } catch (err) {
      if (err instanceof DeliveryCommandError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
    }
  }

  /**
   * `approve_tool` / `reject_tool` 명령 — OpenAI Agents SDK RunToolApprovalItem 응답.
   *
   * Approval uses a separate command because `respond` is reserved for Claude
   * AskUserQuestion. DeliveryCommands owns delivery semantics and ACK shape.
   */
  private async handleToolApproval(cmd: ToolApprovalCommand): Promise<void> {
    try {
      const ack = await this.deliveryCommands.toolApproval(cmd);
      if (ack) {
        await this.send(ack);
      }
    } catch (err) {
      if (err instanceof DeliveryCommandError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
    }
  }

  private async handleRealtimeCreateCall(cmd: RealtimeCreateCallCommand): Promise<void> {
    await this.sendRealtimeCommand(() => this.realtimeCommands.createCall(cmd));
  }

  private async handleRealtimeEvent(cmd: RealtimeEventCommand): Promise<void> {
    await this.sendRealtimeCommand(() => this.realtimeCommands.relayEvent(cmd));
  }

  private async handleRealtimeResolveToolApproval(
    cmd: RealtimeResolveToolApprovalCommand,
  ): Promise<void> {
    await this.sendRealtimeCommand(() =>
      this.realtimeCommands.resolveToolApproval(cmd),
    );
  }

  private async sendRealtimeCommand(
    buildAck: () => Promise<RealtimeCommandAck | null>,
  ): Promise<void> {
    try {
      const ack = await buildAck();
      if (ack) {
        await this.send(ack);
      }
    } catch (err) {
      if (err instanceof RealtimeCommandError) {
        await this.sendRealtimeAckError(
          err.ackType,
          err.requestId,
          err.agentSessionId,
          err.message,
        );
        return;
      }
      throw err;
    }
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

  private async handleHealthCheck(cmd: CommandLike): Promise<void> {
    const agents = this.agentRegistry.list();
    await this.send({
      type: "health_status",
      runners: {
        max_concurrent: agents.length,
        active: this.taskManager.listTasks().filter((t) => t.status === "running").length,
      },
      node_id: this.nodeId,
      requestId: cmd.requestId ?? cmd.request_id ?? "",
    });
  }

  /**
   * `create_session` 명령.
   *
   * TaskRuntimeCommands owns profile lookup, task creation, attachment context,
   * backend-specific OAuth forwarding, and startExecution. Dispatcher keeps the
   * minimal wire guard and requestId-gated `session_created` ACK.
   */
  private async handleCreateSession(cmd: CreateSessionCmd): Promise<void> {
    if (!cmd.agentSessionId || !cmd.prompt) {
      await this.sendError(cmd, "create_session requires agentSessionId and prompt");
      return;
    }
    const profileId = cmd.profile;
    if (!profileId) {
      await this.sendError(cmd, "create_session requires profile (agent id)");
      return;
    }
    let task: Task;
    try {
      task = await this.taskRuntimeCommands.createSession({
        agentSessionId: cmd.agentSessionId,
        prompt: cmd.prompt,
        profileId,
        callerSessionId: cmd.caller_session_id ?? null,
        callerInfo: cmd.caller_info,
        model: cmd.model,
        oauthToken: cmd.oauth_token,
        reasoningEffort: cmd.reasoningEffort,
        allowedTools: cmd.allowed_tools ?? cmd.allowedTools,
        disallowedTools: cmd.disallowed_tools ?? cmd.disallowedTools,
        useMcp: cmd.use_mcp ?? cmd.useMcp,
        folderId: cmd.folderId ?? null,
        systemPrompt: cmd.systemPrompt,
        extraContextItems: cmd.extra_context_items,
        attachmentPaths: cmd.attachment_paths,
      });
    } catch (err) {
      if (err instanceof UnknownAgentProfileError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
    }

    // session_created wire는 *두 경로*가 같은 type을 사용 — orch는 payload 키로 구분:
    //   1. dispatcher ACK (여기): {type, agentSessionId, requestId}  — *requestId 있을 때만*
    //   2. SessionBroadcaster.emitSessionCreated: {type, session, folder_id, caller_source}
    // Python `command_handler.py` L222-227 / `session_broadcaster.py` L67-77 정본 패턴.
    // requestId 없으면 ACK 발행 안 함 (atom c13f7826 빈 string ACK 금지).
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (requestId) {
      await this.send(
        buildSessionCreatedAck({
          requestId,
          agentSessionId: task.agentSessionId,
        }),
      );
    }
  }

  /**
   * `intervene` 명령.
   *
   * TaskRuntimeCommands owns delivery, queueing, and auto-resume. Dispatcher
   * validates the wire minimum, maps runtime failures to the generic error wire,
   * and emits the requestId-gated `intervene_ack`.
   */
  private async handleIntervene(cmd: IntervenCmd): Promise<void> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    if (!sessionId || !cmd.text) {
      await this.sendError(cmd, "intervene requires agentSessionId and text");
      return;
    }

    let result;
    try {
      result = await this.taskRuntimeCommands.intervene({
        agentSessionId: sessionId,
        text: cmd.text,
        user: cmd.user,
        callerInfo: cmd.caller_info,
        attachmentPaths: cmd.attachment_paths,
      });
    } catch (err) {
      await this.sendError(cmd, err instanceof Error ? err.message : String(err));
      return;
    }

    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!requestId) {
      // ACK 발행 안 함 (atom c13f7826 빈 string ACK 금지) — orch _send_command 미사용 경로.
      return;
    }
    await this.send(buildInterveneAck({ requestId, agentSessionId: sessionId, result }));
  }

  private async handleInterruptSession(cmd: InterruptSessionCmd): Promise<void> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    if (!sessionId) {
      await this.sendError(cmd, "interrupt_session requires agentSessionId");
      return;
    }

    const interrupted = await this.taskManager.cancelTask(sessionId);
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!requestId) return;
    await this.send({
      type: "interrupt_session_ack",
      requestId,
      status: "ok",
      interrupted,
      agentSessionId: sessionId,
    });
  }

  /**
   * `subscribe_events` 명령.
   *
   * TS task execution already emits each task event through
   * broadcaster.emitEventEnvelope, so there is no separate relay loop to start.
   * The orch caller sends this command fire-and-forget, and Python also emits no
   * ACK for this command.
   */
  private async handleSubscribeEvents(cmd: SubscribeEventsCmd): Promise<void> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    this.logger.info(
      { sessionId, subscribeId: cmd.subscribeId },
      "subscribe_events received — NOOP 수락 (broadcaster가 EVT_EVENT 직접 emit)",
    );
    // NOOP — ACK 없이 silent 수락.
  }

  /**
   * `list_sessions` 명령 — Python `_handle_list_sessions` 정합.
   *
   * 응답 wire: `{type:"sessions_update", sessions, total, requestId}`.
   *
   * 응답 dict richness 한계: Python은 `get_all_sessions`로 `_build_session_dict` enrich된 dict를
   * 반환하지만 TS는 현재 `listSessionsSummary` (경량 summary)만 노출. wire 소비자(orch
   * `_on_sessions_update`)는 dict를 그대로 저장하므로 키 일관성만 유지하면 동작.
   *
   * SessionListCommands가 hard limit, default offset, sessionDb 의존성 검증, payload 조립을 소유한다.
   */
  private async handleListSessions(cmd: ListSessionsCmd): Promise<void> {
    try {
      await this.send(
        await this.sessionListCommands.listSessions({
          requestId: commandRequestId(cmd),
        }),
      );
    } catch (err) {
      if (err instanceof SessionListCommandError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
    }
  }

  private async handleClaudeAuth(cmd: ClaudeAuthCommand): Promise<void> {
    try {
      const response = await this.claudeAuthCommands.handle(cmd);
      if (response) {
        await this.send(response);
      }
    } catch (err) {
      if (err instanceof ClaudeAuthCommandError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
    }
  }

  private async handleProviderUsage(cmd: ProviderUsageCommand): Promise<void> {
    try {
      await this.send(await this.providerUsageCommands.handle(cmd));
    } catch (err) {
      if (err instanceof ProviderUsageCommandError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
    }
  }

  private async handleUploadAttachment(cmd: UploadAttachmentCmd): Promise<void> {
    const requestId = commandRequestId(cmd);
    try {
      const ack = await this.attachmentCommands.upload({
        requestId,
        sessionId: cmd.session_id,
        filename: cmd.filename,
        contentType: cmd.content_type,
        contentB64: cmd.content_b64,
      });
      if (requestId) {
        await this.send(ack);
      }
    } catch (err) {
      if (err instanceof AttachmentCommandError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
    }
  }

  private async handleDeleteSessionAttachments(
    cmd: DeleteSessionAttachmentsCmd,
  ): Promise<void> {
    const requestId = commandRequestId(cmd);
    try {
      const ack = await this.attachmentCommands.deleteSessionAttachments({
        requestId,
        sessionId: cmd.session_id,
      });
      if (requestId) {
        await this.send(ack);
      }
    } catch (err) {
      if (err instanceof AttachmentCommandError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
    }
  }

  private async handleDownloadAttachment(cmd: DownloadAttachmentCmd): Promise<void> {
    const requestId = commandRequestId(cmd);
    try {
      const ack = await this.attachmentCommands.download({
        requestId,
        path: cmd.path,
      });
      if (requestId) {
        await this.send(ack);
      }
    } catch (err) {
      if (err instanceof AttachmentCommandError) {
        await this.sendError(cmd, err.message);
        return;
      }
      throw err;
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
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function commandRequestId(cmd: CommandLike): string {
  return cmd.requestId ?? cmd.request_id ?? "";
}
