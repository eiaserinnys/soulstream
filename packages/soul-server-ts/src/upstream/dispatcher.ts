import type { Logger } from "pino";

export type SendFn = (data: unknown) => Promise<void>;

interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

/**
 * orch → 노드 명령 디스패처.
 *
 * B-1 핸들러 inventory:
 * - `health_check` → `health_status` 응답
 * - 그 외 → `error: "Not implemented in soul-server-ts B-1"` fallback (위임 §R5)
 *
 * 응답 키는 *camelCase*가 정본 (Python `command_handler.py` L309-317 실측, wire-schema HealthStatus L340-348).
 */
export class CommandDispatcher {
  private readonly handlers: Record<string, (cmd: CommandLike) => Promise<void>>;

  constructor(
    private readonly send: SendFn,
    private readonly logger: Logger,
    private readonly nodeId: string,
  ) {
    this.handlers = {
      health_check: (cmd) => this.handleHealthCheck(cmd),
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
        `Not implemented in soul-server-ts B-1: ${cmd.type}`,
      );
    }
  }

  private async handleHealthCheck(cmd: CommandLike): Promise<void> {
    await this.send({
      type: "health_status",
      runners: { max_concurrent: 0, active: 0 },
      node_id: this.nodeId,
      requestId: cmd.requestId ?? cmd.request_id ?? "",
    });
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
