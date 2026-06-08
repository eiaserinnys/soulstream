import { WebSocket } from "ws";
import type { Logger } from "pino";

import type { AgentConfigService } from "../agent_config_service.js";
import type { AgentRegistry } from "../agent_registry.js";
import type { ClaudeAuthCommandHandler } from "../auth/claude_auth.js";
import type { SessionDB } from "../db/session_db.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { RealtimeBroker } from "../realtime/realtime_broker.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { AttachmentStore } from "../attachments/file_manager.js";
import type { ClaudeRuntimeScheduleCommands } from "./claude_runtime_commands.js";

import { CommandDispatcher } from "./dispatcher.js";
import { ReconnectPolicy } from "./reconnect.js";
import { buildRegistrationMsg } from "./registration.js";
import { SessionListCommands } from "./session_list_commands.js";

const APP_HEARTBEAT_PING = "app_heartbeat_ping";
const APP_HEARTBEAT_PONG = "app_heartbeat_pong";
const APP_HEARTBEAT_INTERVAL_MS = 10_000;
const APP_HEARTBEAT_MAX_MISSED = 2;
const APP_HEARTBEAT_CLOSE_CODE = 1011;

export interface UpstreamConfig {
  url: string;
  nodeId: string;
  host: string;
  port: number;
  authBearerToken: string;
  userName: string;
  userPortraitPath: string;
  isProduction: boolean;
  heartbeatIntervalMs?: number;
  heartbeatMaxMissed?: number;
}

export interface UpstreamDependencies {
  agentRegistry: AgentRegistry;
  taskManager: TaskManager;
  taskExecutor: TaskExecutor;
  attachmentStore?: AttachmentStore;
  claudeAuth?: ClaudeAuthCommandHandler;
  /** Phase B: list_sessions 핸들러 의존성. main.ts에서 주입. */
  sessionDb?: SessionDB;
  realtimeBroker?: RealtimeBroker;
  agentConfigService?: AgentConfigService;
  reflectionRuntime?: McpRuntime;
  scheduleCommands?: ClaudeRuntimeScheduleCommands;
}

/**
 * orch에 역방향 WebSocket 연결. Python `upstream/adapter.py`의 *최소* 등가.
 *
 * 책임:
 * 1. 연결 (Bearer auth)
 * 2. node_register 발행
 * 3. 명령 수신 → dispatcher 전달
 * 4. 자동 재연결 (ReconnectPolicy)
 *
 * B-1에서 *미구현*: EventRelay, intervene/respond/list_sessions 핸들러.
 */
export class UpstreamAdapter {
  private ws: WebSocket | null = null;
  private running = false;
  private readonly reconnect = new ReconnectPolicy();
  private readonly dispatcher: CommandDispatcher;
  private authWarned = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private awaitingHeartbeatPong = false;
  private missedHeartbeatPongs = 0;

  constructor(
    private readonly config: UpstreamConfig,
    private readonly logger: Logger,
    private readonly deps: UpstreamDependencies,
  ) {
    this.dispatcher = new CommandDispatcher(
      (data) => this.send(data),
      logger,
      config.nodeId,
      deps.agentRegistry,
      deps.taskManager,
      deps.taskExecutor,
      deps.attachmentStore,
      deps.claudeAuth,
      deps.sessionDb,
      deps.realtimeBroker,
      undefined,
      deps.agentConfigService,
      deps.reflectionRuntime,
      deps.scheduleCommands,
    );
  }

  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.connectAndServe();
      } catch (err) {
        if (!this.running) break;
        if (isConnectionError(err)) {
          // 예상 연결 오류 — Python adapter.py L122-132 등가
          this.logger.warn({ err }, "Upstream connection failed");
        } else {
          // 예상치 못한 오류 — Python adapter.py L133-136 (logger.exception) 등가
          this.logger.error({ err }, "Unexpected error in upstream connection");
        }
      }
      if (this.running) {
        this.logger.info(
          { attempt: this.reconnect.attempt + 1, delay: this.reconnect.currentDelaySeconds },
          "Reconnecting after delay",
        );
        await this.reconnect.wait();
      }
    }
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.stopAppHeartbeat();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  /**
   * 외부(SessionBroadcaster 등)에서 broadcast 메시지를 보낼 때 진입점.
   * WS 연결이 끊겨 있으면 무음 drop — 호출자가 재시도 책임 없음 (orch 재연결 시 catch up).
   */
  async sendBroadcast(data: unknown): Promise<void> {
    await this.send(data);
  }

  private async connectAndServe(): Promise<void> {
    this.logger.info({ url: this.config.url }, "Connecting to upstream");

    // production 미설정 경고 (1회만)
    if (!this.config.authBearerToken && this.config.isProduction) {
      if (!this.authWarned) {
        this.logger.error(
          "AUTH_BEARER_TOKEN empty in production — orch-server will likely reject this connection",
        );
        this.authWarned = true;
      } else {
        this.logger.debug("AUTH_BEARER_TOKEN still empty (reconnect)");
      }
    }

    const headers: Record<string, string> = {};
    if (this.config.authBearerToken) {
      headers.Authorization = `Bearer ${this.config.authBearerToken}`;
    }

    const ws = new WebSocket(this.config.url, { headers });
    this.ws = ws;

    // 연결 대기
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    this.reconnect.reset();
    this.authWarned = false;
    this.logger.info({ nodeId: this.config.nodeId }, "Connected to upstream");

    // node_register 발행
    await this.send(
      buildRegistrationMsg({
        nodeId: this.config.nodeId,
        host: this.config.host,
        port: this.config.port,
        userName: this.config.userName,
        userPortraitPath: this.config.userPortraitPath,
        agentRegistry: this.deps.agentRegistry,
        logger: this.logger,
      }),
    );
    await this.sendInitialSessions();

    // 명령 수신 루프 — close 또는 error로 종료
    await new Promise<void>((resolve) => {
      const onMessage = async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let cmd: unknown;
        try {
          const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
          cmd = JSON.parse(text);
        } catch (err) {
          this.logger.warn({ err }, "Invalid JSON from upstream");
          return;
        }
        try {
          if (this.handleAppHeartbeatMessage(cmd)) {
            return;
          }
          await this.dispatcher.dispatch(cmd);
        } catch (err) {
          this.logger.error({ err }, "Dispatcher threw");
        }
      };
      const onClose = (code: number, reason: Buffer) => {
        ws.off("message", onMessage);
        ws.off("error", onError);
        this.stopAppHeartbeat();
        this.logger.info({ code, reason: reason.toString("utf-8") }, "Upstream connection closed");
        resolve();
      };
      const onError = (err: Error) => {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        this.stopAppHeartbeat();
        this.logger.warn({ err }, "WebSocket error during serve");
        resolve();
      };
      ws.on("message", onMessage);
      ws.once("close", onClose);
      ws.once("error", onError);
    });

    this.ws = null;
  }

  private startAppHeartbeat(ws: WebSocket): void {
    this.stopAppHeartbeat();
    const intervalMs = this.config.heartbeatIntervalMs ?? APP_HEARTBEAT_INTERVAL_MS;
    const maxMissed = Math.max(1, this.config.heartbeatMaxMissed ?? APP_HEARTBEAT_MAX_MISSED);

    const tick = () => {
      if (ws !== this.ws || ws.readyState !== WebSocket.OPEN) {
        this.stopAppHeartbeat();
        return;
      }

      if (this.awaitingHeartbeatPong) {
        this.missedHeartbeatPongs += 1;
        if (this.missedHeartbeatPongs >= maxMissed) {
          this.logger.warn(
            { missed: this.missedHeartbeatPongs, intervalMs },
            "Upstream app heartbeat timeout",
          );
          ws.close(APP_HEARTBEAT_CLOSE_CODE, "app heartbeat timeout");
          this.stopAppHeartbeat();
          return;
        }
      }

      this.awaitingHeartbeatPong = true;
      void this.sendOnSocket(ws, {
        type: APP_HEARTBEAT_PING,
        sentAt: new Date().toISOString(),
      }).catch((err) => {
        this.logger.warn({ err }, "Failed to send app heartbeat ping");
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(APP_HEARTBEAT_CLOSE_CODE, "app heartbeat send failed");
        }
      });
    };

    tick();
    this.heartbeatTimer = setInterval(tick, intervalMs);
  }

  private stopAppHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingHeartbeatPong = false;
    this.missedHeartbeatPongs = 0;
  }

  private handleAppHeartbeatMessage(msg: unknown): boolean {
    if (!msg || typeof msg !== "object") {
      return false;
    }
    const data = msg as Record<string, unknown>;
    if (data.type === APP_HEARTBEAT_PING) {
      const ws = this.ws;
      void this.send({
        type: APP_HEARTBEAT_PONG,
        sentAt: data.sentAt,
      }).catch((err) => {
        this.logger.warn({ err }, "Failed to send app heartbeat pong");
      });
      if (ws && ws.readyState === WebSocket.OPEN && !this.heartbeatTimer) {
        this.startAppHeartbeat(ws);
      }
      return true;
    }
    if (data.type === APP_HEARTBEAT_PONG) {
      this.awaitingHeartbeatPong = false;
      this.missedHeartbeatPongs = 0;
      return true;
    }
    return false;
  }

  private async sendInitialSessions(): Promise<void> {
    if (!this.deps.sessionDb) {
      this.logger.warn("sessionDb dependency missing — initial sessions_update skipped");
      return;
    }

    try {
      const commands = new SessionListCommands(this.deps.sessionDb, this.config.nodeId);
      await this.send(await commands.listSessions({ requestId: "" }));
    } catch (err) {
      this.logger.warn({ err }, "initial sessions_update failed");
    }
  }

  private async send(data: unknown): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.logger.warn({ data }, "Cannot send — WebSocket not open");
      return;
    }
    await this.sendOnSocket(ws, data);
  }

  private async sendOnSocket(ws: WebSocket, data: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(data), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Node.js 연결 오류 + WS handshake 오류 판별. Python `adapter.py` L122-132의
 * `(WSServerHandshakeError, ClientConnectorError, ClientError, ConnectionError, OSError)` 등가.
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  ) {
    return true;
  }
  // ws 라이브러리의 handshake 실패는 message에 status 또는 "Unexpected server response" 포함
  const msg = err.message;
  return (
    msg.includes("Unexpected server response") ||
    msg.includes("WebSocket") ||
    msg.includes("handshake")
  );
}
