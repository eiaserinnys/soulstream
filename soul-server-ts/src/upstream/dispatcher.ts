import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
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

/**
 * orch → 노드 명령 디스패처.
 *
 * 핸들러 inventory:
 * - `health_check` → `health_status` 응답 (B-1)
 * - `create_session` → task lifecycle 시동 + `session_created` 응답 (B-3)
 * - `intervene` → addIntervention + `intervene_ack` 응답 (B-4)
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
  ) {
    this.handlers = {
      health_check: (cmd) => this.handleHealthCheck(cmd),
      create_session: (cmd) => this.handleCreateSession(cmd as CreateSessionCmd),
      intervene: (cmd) => this.handleIntervene(cmd as IntervenCmd),
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
