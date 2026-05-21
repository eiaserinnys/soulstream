import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type {
  ClaudeAuthCommandHandler,
  ClaudeAuthSetTokenCmd,
} from "../auth/claude_auth.js";
import {
  AttachmentError,
  FileAttachmentStore,
  FileNotFoundError,
  type AttachmentStore,
} from "../attachments/file_manager.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { TaskExecutor } from "../task/task_executor.js";
import { buildAttachmentContextItems, splitAttachmentPaths } from "../task/attachment_context.js";
import type {
  DeliverInputResponseResult,
  DeliverInputResponseStatus,
  DeliverToolApprovalResult,
  DeliverToolApprovalStatus,
  TaskManager,
} from "../task/task_manager.js";
import type { CallerInfo, Task } from "../task/task_models.js";
import type { ReasoningEffort } from "../engine/protocol.js";
import type { SessionDB } from "../db/session_db.js";

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
  reasoningEffort?: ReasoningEffort;
  folderId?: string | null;
  /**
   * B-6 context_builder: 사용자/위임자가 지정한 system_prompt (Python `command_handler.py`
   * `_handle_create_session`이 `cmd.get("systemPrompt")` 그대로 forward 정합).
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

interface RespondCmd extends CommandLike {
  type: "respond";
  agentSessionId?: string;
  session_id?: string;
  inputRequestId?: string;
  answers?: Record<string, unknown>;
}

interface ToolApprovalCmd extends CommandLike {
  type: "approve_tool" | "reject_tool";
  agentSessionId?: string;
  session_id?: string;
  approvalId?: string;
  approval_id?: string;
  message?: string;
  alwaysApprove?: boolean;
  alwaysReject?: boolean;
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

type ClaudeAuthStatusCmd = CommandLike & { type: "claude_auth_status" };
type ClaudeAuthDeleteCmd = CommandLike & { type: "claude_auth_delete_token" };
type ClaudeAuthUsageCmd = CommandLike & { type: "claude_auth_get_usage" };
type ClaudeAuthProfileCmd = CommandLike & { type: "claude_auth_get_profile" };

type ListSessionsCmd = CommandLike & { type: "list_sessions" };

/**
 * `handleListSessions`이 모든 행을 한 번에 dump하기 위한 상한 — Python `_handle_list_sessions`는
 * `get_all_sessions(offset=0, limit=0)` (전체)으로 호출하지만 TS는 페이징된 stored proc만 노출되어
 * 명시 상한이 필요하다. 운영 노드 한대당 동시 활성 세션이 이 값을 초과하면 별 페이징 커맨드를 추가해야 한다.
 */
const LIST_SESSIONS_HARD_LIMIT = 10_000;

/**
 * orch → 노드 명령 디스패처.
 *
 * 핸들러 inventory:
 * - `health_check` → `health_status` 응답 (B-1)
 * - `create_session` → task lifecycle 시동 + `session_created` 응답 (B-3)
 * - `intervene` → addIntervention + `intervene_ack` 응답 (B-4)
 * - `subscribe_events` → NOOP 수락 — broadcaster.emitEventEnvelope이 이미 모든 task event를
 *   wire로 emit하므로 별 relay loop 불필요. Python `command_handler.py:319 _handle_subscribe_events`는
 *   `await relay.relay_events(session_id)`로 *별 relay 루프*를 가지지만, 그것은 Python의 *task-내
 *   broadcaster 단일 채널 없는 구조*를 보완하기 위함. TS는 task_executor._processEvent가 매
 *   event를 broadcaster.emitEventEnvelope으로 emit하므로 별 relay 불필요 (이론).
 *   분석 캐시 `20260518-1218-codex-sse-realtime-sync.md` §본 사이클 fix 결정.
 * - 그 외 → "Not implemented" fallback
 *
 * 응답 키는 *camelCase*가 정본 (Python `command_handler.py` L309-317 실측).
 */
export class CommandDispatcher {
  private readonly handlers: Record<string, (cmd: CommandLike) => Promise<void>>;

  constructor(
    private readonly send: SendFn,
    private readonly logger: Logger,
    private readonly nodeId: string,
    private readonly agentRegistry: AgentRegistry,
    private readonly taskManager: TaskManager,
    private readonly taskExecutor: TaskExecutor,
    private readonly attachmentStore: AttachmentStore = new FileAttachmentStore(".local/incoming"),
    private readonly claudeAuth?: ClaudeAuthCommandHandler,
    /**
     * Phase B: `list_sessions` 핸들러용 세션 DB. legacy 테스트 호환 위해 optional. 미주입 시
     * `list_sessions` 명령은 명시 error 응답 (silent fallback 금지 — 운영자가 누락 인지 가능).
     */
    private readonly sessionDb?: SessionDB,
  ) {
    this.handlers = {
      health_check: (cmd) => this.handleHealthCheck(cmd),
      create_session: (cmd) => this.handleCreateSession(cmd as CreateSessionCmd),
      intervene: (cmd) => this.handleIntervene(cmd as IntervenCmd),
      respond: (cmd) => this.handleRespond(cmd as RespondCmd),
      approve_tool: (cmd) => this.handleToolApproval(cmd as ToolApprovalCmd),
      reject_tool: (cmd) => this.handleToolApproval(cmd as ToolApprovalCmd),
      subscribe_events: (cmd) => this.handleSubscribeEvents(cmd as SubscribeEventsCmd),
      list_sessions: (cmd) => this.handleListSessions(cmd as ListSessionsCmd),
      upload_attachment: (cmd) => this.handleUploadAttachment(cmd as UploadAttachmentCmd),
      delete_session_attachments: (cmd) =>
        this.handleDeleteSessionAttachments(cmd as DeleteSessionAttachmentsCmd),
      download_attachment: (cmd) =>
        this.handleDownloadAttachment(cmd as DownloadAttachmentCmd),
      claude_auth_status: (cmd) => this.handleClaudeAuthStatus(cmd as ClaudeAuthStatusCmd),
      claude_auth_set_token: (cmd) =>
        this.handleClaudeAuthSetToken(cmd as CommandLike & ClaudeAuthSetTokenCmd),
      claude_auth_delete_token: (cmd) =>
        this.handleClaudeAuthDeleteToken(cmd as ClaudeAuthDeleteCmd),
      claude_auth_get_usage: (cmd) => this.handleClaudeAuthGetUsage(cmd as ClaudeAuthUsageCmd),
      claude_auth_get_profile: (cmd) =>
        this.handleClaudeAuthGetProfile(cmd as ClaudeAuthProfileCmd),
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
   * 모든 실패도 respond_ack(status="error")로 회신하여 orch _send_command timeout을 막는다.
   */
  private async handleRespond(cmd: RespondCmd): Promise<void> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    const inputRequestId = cmd.inputRequestId ?? cmd.request_id ?? "";
    if (!sessionId || !inputRequestId || !isPlainObject(cmd.answers)) {
      await this.sendError(
        cmd,
        "respond requires agentSessionId, inputRequestId, and answers",
      );
      return;
    }

    const result = await this.taskManager.deliverInputResponse({
      agentSessionId: sessionId,
      requestId: inputRequestId,
      answers: cmd.answers,
    });

    const requestId = cmd.requestId ?? "";
    if (!requestId) {
      return;
    }
    if (result.status === "delivered") {
      await this.send({
        type: "respond_ack",
        requestId,
        inputRequestId,
        status: "ok",
        delivered: true,
        ...(result.eventId !== undefined ? { eventId: result.eventId } : {}),
      });
      return;
    }

    await this.send({
      type: "respond_ack",
      requestId,
      inputRequestId,
      status: "error",
      code: respondErrorCode(result.status),
      message: result.message ?? defaultRespondErrorMessage(result),
      ...(result.backend ? { backend: result.backend } : {}),
      ...(result.taskStatus ? { taskStatus: result.taskStatus } : {}),
    });
  }

  /**
   * `approve_tool` / `reject_tool` 명령 — OpenAI Agents SDK RunToolApprovalItem 응답.
   *
   * `respond` 명령은 Claude AskUserQuestion 전용이므로 승인 wire를 별도 명령으로 둔다.
   * 실패도 `tool_approval_ack(status="error")`로 반환해 orch `_send_command` timeout을 막는다.
   */
  private async handleToolApproval(cmd: ToolApprovalCmd): Promise<void> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    const approvalId = cmd.approvalId ?? cmd.approval_id ?? "";
    if (!sessionId || !approvalId) {
      await this.sendError(cmd, `${cmd.type} requires agentSessionId and approvalId`);
      return;
    }

    const decision = cmd.type === "approve_tool" ? "approved" : "rejected";
    const result = await this.taskManager.deliverToolApproval({
      agentSessionId: sessionId,
      approvalId,
      decision,
      ...(cmd.message ? { message: cmd.message } : {}),
      ...(cmd.alwaysApprove !== undefined ? { alwaysApprove: cmd.alwaysApprove } : {}),
      ...(cmd.alwaysReject !== undefined ? { alwaysReject: cmd.alwaysReject } : {}),
    });

    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!requestId) {
      return;
    }
    if (result.status === "delivered") {
      await this.send({
        type: "tool_approval_ack",
        requestId,
        approvalId,
        decision,
        status: "ok",
        delivered: true,
        ...(result.eventId !== undefined ? { eventId: result.eventId } : {}),
      });
      return;
    }

    await this.send({
      type: "tool_approval_ack",
      requestId,
      approvalId,
      decision,
      status: "error",
      code: toolApprovalErrorCode(result.status),
      message: result.message ?? defaultToolApprovalErrorMessage(result),
      ...(result.backend ? { backend: result.backend } : {}),
      ...(result.taskStatus ? { taskStatus: result.taskStatus } : {}),
    });
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
   * `create_session` 명령 — Phase B-3 신설.
   *
   * 흐름:
   *   1. agent_registry.get(profile) → AgentProfile (없으면 error 응답)
   *   2. task_manager.createTask(...) → DB session_register + broadcast session_created
   *   3. task_executor.startExecution(task, profile) → engine.execute() fire-and-forget
   *   4. requestId가 있으면 `session_created` ACK 응답 (atom c13f7826: 빈 string ACK 금지)
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
    const agent = this.agentRegistry.get(profileId);
    if (!agent) {
      await this.sendError(cmd, `Unknown agent profile: ${profileId}`);
      return;
    }

    const { nonImagePaths } = splitAttachmentPaths(cmd.attachment_paths);
    const task = await this.taskManager.createTask({
      agentSessionId: cmd.agentSessionId,
      prompt: cmd.prompt,
      profileId,
      callerSessionId: cmd.caller_session_id ?? null,
      callerInfo: cmd.caller_info,
      model: cmd.model,
      oauthToken: agent.backend === "claude" ? normalizeOptionalString(cmd.oauth_token) : undefined,
      reasoningEffort: cmd.reasoningEffort,
      allowedTools: cmd.allowed_tools,
      disallowedTools: cmd.disallowed_tools,
      useMcp: cmd.use_mcp,
      folderId: cmd.folderId ?? null,
      systemPrompt: cmd.systemPrompt,  // B-6 context_builder가 folder_prompt와 합성
      contextItems: cmd.extra_context_items ?? buildAttachmentContextItems(nonImagePaths),
      attachmentPaths: cmd.attachment_paths,
    });

    this.taskExecutor.startExecution(task, agent);

    // session_created wire는 *두 경로*가 같은 type을 사용 — orch는 payload 키로 구분:
    //   1. dispatcher ACK (여기): {type, agentSessionId, requestId}  — *requestId 있을 때만*
    //   2. SessionBroadcaster.emitSessionCreated: {type, session, folder_id, caller_source}
    // Python `command_handler.py` L222-227 / `session_broadcaster.py` L67-77 정본 패턴.
    // requestId 없으면 ACK 발행 안 함 (atom c13f7826 빈 string ACK 금지).
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (requestId) {
      await this.send({
        type: "session_created",
        agentSessionId: task.agentSessionId,
        requestId,
      });
    }
  }

  /**
   * `intervene` 명령 — B-4 구현 (분석 캐시 `20260517-1410-codex-ts-folder-resume-intervene.md` §D).
   *
   * Codex SDK 0.130.0은 turn-level steer를 지원하지 않으므로 *turn 사이 큐잉*으로 정합:
   *   - Running 세션 → interventionQueue에 push, 현 turn 종료 후 task_executor가 dequeue하여
   *     다음 turn 자동 진입 (resumeThread). 응답 `intervene_ack(status="queued", queuePosition)`.
   *   - Completed/Error/Interrupted 세션 → status=running 전환 + queue push + startExecution
   *     재호출 → 다음 turn이 resumeThread(task.codexThreadId)로 자동 진입. 응답
   *     `intervene_ack(status="auto_resumed", agentSessionId)`.
   *   - 미존재 task → addIntervention throw → sendError.
   *
   * Python `intervention_service.intervene` L28-79 정본 패턴의 codex 적응판. 응답 형상은
   * Python `_handle_intervene` L249-254와 키 정합 (`intervene_ack`, `requestId`, `status`).
   */
  private async handleIntervene(cmd: IntervenCmd): Promise<void> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    if (!sessionId || !cmd.text) {
      await this.sendError(cmd, "intervene requires agentSessionId and text");
      return;
    }

    const onResume = (task: Task) => {
      if (!task.profileId) {
        this.logger.error(
          { sessionId: task.agentSessionId },
          "intervene auto-resume aborted — task missing profileId",
        );
        return;
      }
      const agent = this.agentRegistry.get(task.profileId);
      if (!agent) {
        this.logger.error(
          { sessionId: task.agentSessionId, profileId: task.profileId },
          "intervene auto-resume aborted — agent profile not found",
        );
        return;
      }
      this.taskExecutor.startExecution(task, agent);
    };

    let result;
    try {
      result = await this.taskManager.addIntervention(
        {
          agentSessionId: sessionId,
          text: cmd.text,
          user: cmd.user ?? "upstream",
          callerInfo: cmd.caller_info,
          attachmentPaths: cmd.attachment_paths,
        },
        onResume,
      );
    } catch (err) {
      await this.sendError(cmd, err instanceof Error ? err.message : String(err));
      return;
    }

    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!requestId) {
      // ACK 발행 안 함 (atom c13f7826 빈 string ACK 금지) — orch _send_command 미사용 경로.
      return;
    }
    // wire 정본은 Python `command_handler.py:244-248` — `status:"ok"`로 통일. orch는
    // requestId만으로 future를 resolve(`node_connection.py:397-405`)하여 status 값 분기 없음 —
    // 따라서 status 값을 통일해도 동작 영향 0이지만 design-principles §9 일관성·대칭성 정합.
    // 부가 정보(queuePosition · agentSessionId)는 그대로 운반 — 향후 orch가 ACK 본문을
    // 활용하면 즉시 사용 가능.
    if ("queued" in result) {
      await this.send({
        type: "intervene_ack",
        requestId,
        status: "ok",
        outcome: "queued",
        queuePosition: result.queuePosition,
      });
    } else {
      await this.send({
        type: "intervene_ack",
        requestId,
        status: "ok",
        outcome: "auto_resumed",
        agentSessionId: sessionId,
      });
    }
  }

  /**
   * `subscribe_events` 명령 — broadcaster.emitEventEnvelope이 이미 task event 전체를 emit하므로
   * 별 relay 작업 없이 NOOP 수락.
   *
   * Python 정본 `command_handler.py:319 _handle_subscribe_events`는 `await relay.relay_events(...)`로
   * 별 relay 루프를 가진다 — 그 루프가 *Python의 task-내 단일 broadcaster 채널 없는 구조*를
   * 보완한다. TS는 task_executor._processEvent가 매 codex CLI yield event마다
   * broadcaster.emitEventEnvelope을 호출하므로 별 relay 루프 *불필요* (이론).
   *
   * 본 핸들러 신설 이전(PR #62 시점) 동작:
   *   - dispatcher가 "Not implemented" error 응답을 wire에 발행
   *   - orch는 EVT_ERROR를 warn log만 박고 listener 유지 (직접 차단 안 함)
   *   - 그러나 *간접 차단 가능성*: 사용자 보고로 SSE realtime stream 누락 확정 — 가설 X
   *
   * 본 핸들러는 *명시 ACK 없이 silent 수락*. ACK 발행 안 함이 Python 정본 정합 — Python
   * _handle_subscribe_events도 별도 ACK type을 emit하지 않고 relay loop만 시작.
   * orch send_subscribe_events는 ACK 대기 없이 listener 등록 + cmd send (fire-and-forget).
   * 따라서 ACK 없음으로 orch 동작 영향 0.
   *
   * 진단용 logger.info — 라이브에서 본 cmd가 분명히 도달함을 trace. *node LOG_LEVEL=info*에서
   * 가시.
   */
  private async handleSubscribeEvents(cmd: SubscribeEventsCmd): Promise<void> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    this.logger.info(
      { sessionId, subscribeId: cmd.subscribeId },
      "subscribe_events received — NOOP 수락 (broadcaster가 EVT_EVENT 직접 emit)",
    );
    // NOOP — ACK 없이 silent 수락. Python `_handle_subscribe_events`는 relay loop를 시작하지만
    // TS는 broadcaster.emitEventEnvelope이 이미 task event 전체를 wire로 emit하므로 별 relay 불필요.
  }

  /**
   * `list_sessions` 명령 — Python `_handle_list_sessions` (command_handler.py:351-359) 정합.
   *
   * 응답 wire: `{type:"sessions_update", sessions, total, requestId}`.
   *
   * 응답 dict richness 한계: Python은 `get_all_sessions`로 `_build_session_dict` enrich된 dict를
   * 반환하지만 TS는 현재 `listSessionsSummary` (경량 summary)만 노출. wire 소비자(orch
   * `_on_sessions_update`)는 dict를 그대로 저장하므로 키 일관성만 유지하면 동작. 후속 카드(F-X1)에서
   * 응답 dict richness 보강.
   *
   * sessionDb 미주입 시 silent fallback 대신 명시 error로 운영자가 누락을 인지하게 한다 (§4 명시적 실패).
   */
  private async handleListSessions(cmd: ListSessionsCmd): Promise<void> {
    if (!this.sessionDb) {
      await this.sendError(
        cmd,
        "list_sessions handler requires session_db dependency — wire main.ts CommandDispatcher with SessionDB",
      );
      return;
    }
    const { sessions, total } = await this.sessionDb.listSessionsSummary({
      limit: LIST_SESSIONS_HARD_LIMIT,
      offset: 0,
    });
    await this.send({
      type: "sessions_update",
      sessions,
      total,
      requestId: cmd.requestId ?? cmd.request_id ?? "",
    });
  }

  private async handleClaudeAuthStatus(cmd: ClaudeAuthStatusCmd): Promise<void> {
    const auth = await this.requireClaudeAuth(cmd);
    if (!auth) return;
    await this.send(auth.status(commandRequestId(cmd), "claude_auth_status"));
  }

  private async handleClaudeAuthSetToken(
    cmd: CommandLike & ClaudeAuthSetTokenCmd,
  ): Promise<void> {
    const auth = await this.requireClaudeAuth(cmd);
    if (!auth) return;
    const result = auth.setToken(cmd, commandRequestId(cmd), "claude_auth_set_token");
    if (result.error) {
      await this.sendError(cmd, result.error);
      return;
    }
    if (result.response) {
      await this.send(result.response);
    }
  }

  private async handleClaudeAuthDeleteToken(cmd: ClaudeAuthDeleteCmd): Promise<void> {
    const auth = await this.requireClaudeAuth(cmd);
    if (!auth) return;
    await this.send(auth.deleteToken(commandRequestId(cmd), "claude_auth_delete_token"));
  }

  private async handleClaudeAuthGetUsage(cmd: ClaudeAuthUsageCmd): Promise<void> {
    const auth = await this.requireClaudeAuth(cmd);
    if (!auth) return;
    await this.send(await auth.fetchUsage(commandRequestId(cmd), "claude_auth_get_usage"));
  }

  private async handleClaudeAuthGetProfile(cmd: ClaudeAuthProfileCmd): Promise<void> {
    const auth = await this.requireClaudeAuth(cmd);
    if (!auth) return;
    await this.send(await auth.fetchProfile(commandRequestId(cmd), "claude_auth_get_profile"));
  }

  private async requireClaudeAuth(cmd: CommandLike): Promise<ClaudeAuthCommandHandler | null> {
    if (!this.agentRegistry.supportedBackends().includes("claude")) {
      await this.sendError(
        cmd,
        "Claude backend is not registered on this node; Claude auth commands are unsupported",
      );
      return null;
    }
    if (!this.claudeAuth) {
      await this.sendError(cmd, "Claude auth service is not configured in soul-server-ts");
      return null;
    }
    return this.claudeAuth;
  }

  private async handleUploadAttachment(cmd: UploadAttachmentCmd): Promise<void> {
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!cmd.content_b64) {
      await this.sendError(cmd, "INVALID_REQUEST: content_b64 누락");
      return;
    }
    if (!cmd.session_id) {
      await this.sendError(cmd, "INVALID_REQUEST: session_id 누락");
      return;
    }

    let content: Buffer;
    try {
      content = Buffer.from(cmd.content_b64, "base64");
      if (content.toString("base64").replace(/=+$/, "") !== cmd.content_b64.replace(/=+$/, "")) {
        throw new Error("invalid base64");
      }
    } catch (err) {
      await this.sendError(cmd, `INVALID_REQUEST: base64 디코딩 실패: ${stringifyError(err)}`);
      return;
    }

    try {
      const result = await this.attachmentStore.saveFileForSession({
        sessionId: cmd.session_id,
        filename: cmd.filename || "unnamed",
        content,
        contentType: cmd.content_type || "application/octet-stream",
      });
      if (requestId) {
        await this.send({
          type: "upload_attachment_result",
          requestId,
          path: result.path,
          filename: result.filename,
          size: result.size,
          content_type: result.content_type,
        });
      }
    } catch (err) {
      if (err instanceof AttachmentError) {
        await this.sendError(cmd, `INVALID_REQUEST: ${err.message}`);
        return;
      }
      throw err;
    }
  }

  private async handleDeleteSessionAttachments(
    cmd: DeleteSessionAttachmentsCmd,
  ): Promise<void> {
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!cmd.session_id) {
      await this.sendError(cmd, "INVALID_REQUEST: session_id 누락");
      return;
    }
    const filesRemoved = await this.attachmentStore.cleanupSession(cmd.session_id);
    if (requestId) {
      await this.send({
        type: "delete_session_attachments_result",
        requestId,
        cleaned: true,
        files_removed: filesRemoved,
      });
    }
  }

  private async handleDownloadAttachment(cmd: DownloadAttachmentCmd): Promise<void> {
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!cmd.path) {
      await this.sendError(cmd, "INVALID_REQUEST: path 누락 또는 빈 문자열");
      return;
    }
    try {
      const result = await this.attachmentStore.downloadAttachment(cmd.path);
      if (requestId) {
        await this.send({
          type: "download_attachment_result",
          requestId,
          content_b64: result.content_b64,
          content_type: result.content_type,
          filename: result.filename,
          size: result.size,
        });
      }
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        await this.sendError(cmd, `NOT_FOUND: ${err.message}`);
        return;
      }
      if (err instanceof AttachmentError) {
        await this.sendError(cmd, `INVALID_REQUEST: ${err.message}`);
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

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function commandRequestId(cmd: CommandLike): string {
  return cmd.requestId ?? cmd.request_id ?? "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function respondErrorCode(status: Exclude<DeliverInputResponseStatus, "delivered">): string {
  switch (status) {
    case "expired":
      return "INPUT_REQUEST_EXPIRED";
    case "already_responded":
      return "INPUT_REQUEST_ALREADY_RESPONDED";
    case "request_not_pending":
      return "REQUEST_NOT_PENDING";
    case "session_not_running":
      return "SESSION_NOT_RUNNING";
    case "session_not_found":
      return "SESSION_NOT_FOUND";
    case "not_supported":
      return "INPUT_RESPONSE_NOT_SUPPORTED";
  }
}

function defaultRespondErrorMessage(result: DeliverInputResponseResult): string {
  switch (result.status) {
    case "expired":
      return `Input request expired: ${result.requestId}`;
    case "already_responded":
      return `Input request already responded: ${result.requestId}`;
    case "request_not_pending":
      return `Input request not pending: ${result.requestId}`;
    case "session_not_running":
      return `Session is not running: ${result.taskStatus ?? "unknown"}`;
    case "session_not_found":
      return `Session not found for input response`;
    case "not_supported":
      return `Input response is not supported by backend: ${result.backend ?? "unknown"}`;
    case "delivered":
      return "Input response delivered";
  }
}

function toolApprovalErrorCode(
  status: Exclude<DeliverToolApprovalStatus, "delivered">,
): string {
  switch (status) {
    case "approval_not_pending":
      return "TOOL_APPROVAL_NOT_PENDING";
    case "already_resolved":
      return "TOOL_APPROVAL_ALREADY_RESOLVED";
    case "session_not_running":
      return "SESSION_NOT_RUNNING";
    case "session_not_found":
      return "SESSION_NOT_FOUND";
    case "not_supported":
      return "TOOL_APPROVAL_NOT_SUPPORTED";
  }
}

function defaultToolApprovalErrorMessage(result: DeliverToolApprovalResult): string {
  switch (result.status) {
    case "approval_not_pending":
      return `Tool approval not pending: ${result.approvalId}`;
    case "already_resolved":
      return `Tool approval already resolved: ${result.approvalId}`;
    case "session_not_running":
      return `Session is not running: ${result.taskStatus ?? "unknown"}`;
    case "session_not_found":
      return "Session not found for tool approval";
    case "not_supported":
      return `Tool approval is not supported by backend: ${result.backend ?? "unknown"}`;
    case "delivered":
      return "Tool approval delivered";
  }
}
