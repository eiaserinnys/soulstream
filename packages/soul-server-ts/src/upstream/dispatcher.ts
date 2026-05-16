import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { CallerInfo } from "../task/task_models.js";

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

/**
 * orch → 노드 명령 디스패처.
 *
 * Phase B-3 핸들러 inventory:
 * - `health_check` → `health_status` 응답 (B-1 유지, runners 통계는 task_manager 기반)
 * - `create_session` → task lifecycle 시동 + `session_created` 응답 (B-3 신설)
 * - `intervene` → "Not implemented" fallback (B-4)
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
      intervene: (cmd) => this.handleIntervene(cmd),
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
   * `intervene` 명령 — B-3 fallback "Not implemented".
   *
   * Codex SDK 0.130.0은 turn-level steer API 표면 없음 (TurnOptions에 input 주입 미지원).
   * B-4 multi-turn 지원 시 SDK 표면 변화 또는 다음 turn 우회 패턴 검토.
   */
  private async handleIntervene(cmd: CommandLike): Promise<void> {
    await this.sendError(
      cmd,
      "intervene not implemented in soul-server-ts B-3 (Codex SDK turn-level steer is B-4 work)",
    );
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
