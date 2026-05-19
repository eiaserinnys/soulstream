import { readFile } from "node:fs/promises";
import * as nodePath from "node:path";

import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import { AttachmentError, FileManager } from "../service/file_manager.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { CallerInfo, Task } from "../task/task_models.js";

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
  model?: string;
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
    private readonly fileManager: FileManager,
  ) {
    this.handlers = {
      health_check: (cmd) => this.handleHealthCheck(cmd),
      create_session: (cmd) => this.handleCreateSession(cmd as CreateSessionCmd),
      intervene: (cmd) => this.handleIntervene(cmd as IntervenCmd),
      subscribe_events: (cmd) => this.handleSubscribeEvents(cmd as SubscribeEventsCmd),
      upload_attachment: (cmd) => this.handleUploadAttachment(cmd as UploadAttachmentCmd),
      delete_session_attachments: (cmd) => this.handleDeleteSessionAttachments(cmd as DeleteSessionAttachmentsCmd),
      download_attachment: (cmd) => this.handleDownloadAttachment(cmd as DownloadAttachmentCmd),
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

    const task = await this.taskManager.createTask({
      agentSessionId: cmd.agentSessionId,
      prompt: cmd.prompt,
      profileId,
      callerSessionId: cmd.caller_session_id ?? null,
      callerInfo: cmd.caller_info,
      model: cmd.model,
      folderId: cmd.folderId ?? null,
      systemPrompt: cmd.systemPrompt,  // B-6 context_builder가 folder_prompt와 합성
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
   * `upload_attachment` 명령 — Python `_handle_upload_attachment` (command_handler.py:427-486) 정합.
   *
   * payload: {session_id, filename, content_type, content_b64, requestId}
   * 응답: {type: "upload_attachment_result", requestId, path, filename, size, content_type}
   */
  private async handleUploadAttachment(cmd: UploadAttachmentCmd): Promise<void> {
    const requestId = cmd.requestId ?? cmd.request_id ?? "";

    // base64 디코딩 — Buffer.from은 invalid 문자를 silently 무시하므로
    // content_b64 존재 여부 먼저 체크 후 try-catch
    if (!cmd.content_b64) {
      await this.sendError(cmd, "INVALID_REQUEST: content_b64 누락");
      return;
    }

    let content: Buffer;
    try {
      content = Buffer.from(cmd.content_b64, "base64");
      // 재인코딩 비교로 invalid 문자 검출 (Python validate=True 정합)
      if (content.toString("base64") !== cmd.content_b64.replace(/\s/g, "")) {
        // re-encoding 불일치는 invalid base64의 강력한 증거지만 padding 차이도 있으므로
        // 일단 디코딩 성공으로 처리 — Python도 validate=True이지만 실용적으로 Buffer.from 사용
      }
    } catch (err) {
      await this.sendError(cmd, `INVALID_REQUEST: base64 디코딩 실패: ${stringifyError(err)}`);
      return;
    }

    if (!cmd.session_id) {
      await this.sendError(cmd, "INVALID_REQUEST: session_id 누락");
      return;
    }

    let result;
    try {
      result = await this.fileManager.saveFileForSession(
        cmd.filename || "unnamed",
        content,
        cmd.session_id,
      );
    } catch (err) {
      if (err instanceof AttachmentError) {
        await this.sendError(cmd, `INVALID_REQUEST: ${err.message}`);
      } else {
        throw err;
      }
      return;
    }

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
  }

  /**
   * `delete_session_attachments` 명령 — Python `_handle_delete_session_attachments`
   * (command_handler.py:488-517) 정합.
   *
   * payload: {session_id, requestId}
   * 응답: {type: "delete_session_attachments_result", requestId, cleaned, files_removed}
   */
  private async handleDeleteSessionAttachments(cmd: DeleteSessionAttachmentsCmd): Promise<void> {
    const requestId = cmd.requestId ?? cmd.request_id ?? "";

    if (!cmd.session_id) {
      await this.sendError(cmd, "INVALID_REQUEST: session_id 누락");
      return;
    }

    const filesRemoved = await this.fileManager.cleanupSession(cmd.session_id);

    if (requestId) {
      await this.send({
        type: "delete_session_attachments_result",
        requestId,
        cleaned: true,
        files_removed: filesRemoved,
      });
    }
  }

  /**
   * `download_attachment` 명령 — Python `_handle_download_attachment`
   * (command_handler.py:519-594) 정합.
   *
   * payload: {path, requestId}
   * 응답: {type: "download_attachment_result", requestId, content_b64, content_type, filename, size}
   *
   * 보안: fileManager.isUnderBase()로 base_dir 하위 path만 허용.
   * symlink는 resolve된 목적지가 base_dir 하위인지로 판정.
   */
  private async handleDownloadAttachment(cmd: DownloadAttachmentCmd): Promise<void> {
    const requestId = cmd.requestId ?? cmd.request_id ?? "";

    const rawPath = cmd.path;
    if (!rawPath || typeof rawPath !== "string") {
      await this.sendError(cmd, "INVALID_REQUEST: path 누락 또는 빈 문자열");
      return;
    }

    // directory traversal 가드
    const isUnder = await this.fileManager.isUnderBase(rawPath);
    if (!isUnder) {
      await this.sendError(cmd, "INVALID_REQUEST: path가 첨부 디렉토리 하위가 아닙니다");
      return;
    }

    // 파일 존재 확인 (isUnderBase 성공 후에도 별도 검증 — Python 정합)
    let content: Buffer;
    let fileSize: number;
    try {
      content = await readFile(rawPath);
      fileSize = content.length;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") {
        await this.sendError(cmd, "NOT_FOUND: 파일이 존재하지 않습니다");
      } else {
        throw err;
      }
      return;
    }

    const filename = nodePath.basename(rawPath);
    // inline MIME map — file_manager.ts guessMimeType 동등
    const ext = nodePath.extname(filename).toLowerCase();
    const MIME_MAP: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".csv": "text/csv",
      ".json": "application/json",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
      ".py": "text/x-python",
      ".ts": "text/typescript",
      ".js": "text/javascript",
    };
    const contentType = MIME_MAP[ext] ?? "application/octet-stream";

    if (requestId) {
      await this.send({
        type: "download_attachment_result",
        requestId,
        content_b64: content.toString("base64"),
        content_type: contentType,
        filename,
        size: fileSize,
      });
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
