import { WebSocket } from "ws";
import type { Logger } from "pino";

import { CommandDispatcher } from "./dispatcher.js";
import { CommandTransportObserver } from "./command_transport_observer.js";
import { ReconnectPolicy } from "./reconnect.js";
import { buildRegistrationMsg } from "./registration.js";
import { SessionListCommands } from "./session_list_commands.js";
import { isConnectionError } from "./adapter_connection_error.js";
import type {
  ReconnectPolicyBoundary,
  UpstreamConfig,
  UpstreamDependencies,
} from "./adapter_types.js";

export type {
  ReconnectPolicyBoundary,
  UpstreamConfig,
  UpstreamDependencies,
} from "./adapter_types.js";
export { isConnectionError } from "./adapter_connection_error.js";

const APP_HEARTBEAT_PING = "app_heartbeat_ping";
const APP_HEARTBEAT_PONG = "app_heartbeat_pong";
const APP_HEARTBEAT_INTERVAL_MS = 10_000;
const APP_HEARTBEAT_MAX_MISSED = 2;
const APP_HEARTBEAT_CLOSE_CODE = 1011;
const INITIAL_SESSION_REPORT_MAX_ATTEMPTS = 5;
const INITIAL_SESSION_REPORT_BASE_DELAY_MS = 100;

/**
 * orch에 역방향 WebSocket 연결.
 *
 * 책임:
 * 1. 연결 (Bearer auth)
 * 2. node_register 발행
 * 3. 명령 수신 → dispatcher 전달
 * 4. 자동 재연결 (ReconnectPolicy)
 * 명령별 처리 범위는 CommandDispatcher와 command family 모듈이 정본이다.
 */
export class UpstreamAdapter {
  private ws: WebSocket | null = null;
  private running = false;
  private readonly reconnect: ReconnectPolicyBoundary;
  private readonly dispatcher: CommandDispatcher;
  private readonly commandTransportObserver: CommandTransportObserver;
  private authWarned = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private awaitingHeartbeatPong = false;
  private missedHeartbeatPongs = 0;

  constructor(
    private readonly config: UpstreamConfig,
    private readonly logger: Logger,
    private readonly deps: UpstreamDependencies,
  ) {
    this.reconnect = deps.reconnectPolicy ?? new ReconnectPolicy();
    this.commandTransportObserver = new CommandTransportObserver(logger);
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
      deps.deliveryV2Enabled,
      deps.modelCatalog,
      deps.agentProfileSource,
      async () => await this.listRunningSessionIds(),
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
    this.deps.eventOutboxPump?.disconnect();
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

  /**
   * agents.yaml hot reload 후 현재 AgentRegistry 전체를 orch에 다시 광고한다.
   * 별도 wire를 추가하지 않고 초기 등록과 같은 node_register payload를 재사용한다.
   */
  async reannounceAgentCatalog(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        { nodeId: this.config.nodeId },
        "Agent catalog reannounce skipped — upstream WebSocket not open",
      );
      return;
    }

    const msg = buildRegistrationMsg({
      nodeId: this.config.nodeId,
      host: this.config.host,
      port: this.config.port,
      userName: this.config.userName,
      userPortraitPath: this.config.userPortraitPath,
      agentRegistry: this.deps.agentRegistry,
      modelCatalog: this.deps.modelCatalog,
      runnerProcessEnabled: this.config.runnerProcessEnabled,
      runnerLeaseTimeoutMs: this.config.runnerLeaseTimeoutMs,
      logger: this.logger,
    });

    try {
      await this.sendOnSocket(ws, msg);
      this.logger.info(
        {
          nodeId: this.config.nodeId,
          agentCount: msg.agents?.length ?? 0,
          supportedBackends: msg.supported_backends ?? [],
        },
        "Agent catalog reannounced to upstream",
      );
    } catch (err) {
      this.logger.warn(
        { err, nodeId: this.config.nodeId },
        "Agent catalog reannounce failed",
      );
    }
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

    this.logger.info({ nodeId: this.config.nodeId }, "Upstream WebSocket opened");

    // 명령 수신 루프 — node_register 직후 orch heartbeat가 와도 놓치지 않도록
    // registration 발행 전에 listener를 먼저 설치한다.
    let registrationAccepted = false;
    let resolveRegistration!: () => void;
    const registrationPromise = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    const activeHandlers = new Set<Promise<void>>();
    const servePromise = new Promise<void>((resolve) => {
      let settled = false;
      const handleMessage = async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let cmd: unknown;
        try {
          const text = Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf-8")
            : Buffer.isBuffer(raw)
              ? raw.toString("utf-8")
              : raw instanceof ArrayBuffer
                ? Buffer.from(raw).toString("utf-8")
                : String(raw);
          cmd = JSON.parse(text);
        } catch (err) {
          this.logger.warn({ err }, "Invalid JSON from upstream");
          return;
        }
        try {
          if (isNodeRegisterAck(cmd, this.config.nodeId)) {
            if (!registrationAccepted) {
              registrationAccepted = true;
              resolveRegistration();
            }
            return;
          }
          if (await this.handleAppHeartbeatMessage(cmd)) {
            return;
          }
          if (this.deps.eventOutboxPump?.isAck(cmd)) {
            await this.deps.eventOutboxPump.handleAck(cmd);
            return;
          }
          if (this.deps.eventOutboxPump?.isRejection(cmd)) {
            await this.deps.eventOutboxPump.handleRejection(cmd);
            return;
          }
          await this.commandTransportObserver.observe(
            cmd,
            () => this.dispatcher.dispatch(cmd),
            this.dispatcher.expectsResponse(cmd),
          );
        } catch (err) {
          this.logger.error({ err }, "Dispatcher threw");
        }
      };
      const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const active = handleMessage(raw);
        activeHandlers.add(active);
        void active.finally(() => activeHandlers.delete(active));
      };
      const settle = async (
        kind: "close" | "error",
        detail: { code: number; reason: Buffer } | { err: Error },
      ) => {
        if (settled) return;
        settled = true;
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
        await Promise.allSettled([...activeHandlers]);
        this.stopAppHeartbeat();
        this.deps.eventOutboxPump?.disconnect();
        if (kind === "close" && "code" in detail) {
          this.logger.info(
            { code: detail.code, reason: detail.reason.toString("utf-8") },
            "Upstream connection closed",
          );
        } else if ("err" in detail) {
          this.logger.warn({ err: detail.err }, "WebSocket error during serve");
        }
        resolve();
      };
      const onClose = (code: number, reason: Buffer) => {
        void settle("close", { code, reason });
      };
      const onError = (err: Error) => {
        void settle("error", { err });
      };
      ws.on("message", onMessage);
      ws.once("close", onClose);
      ws.once("error", onError);
    });

    try {
      // node_register 발행
      await this.send(
        buildRegistrationMsg({
          nodeId: this.config.nodeId,
          host: this.config.host,
          port: this.config.port,
          userName: this.config.userName,
          userPortraitPath: this.config.userPortraitPath,
          agentRegistry: this.deps.agentRegistry,
          modelCatalog: this.deps.modelCatalog,
          runnerProcessEnabled: this.config.runnerProcessEnabled,
          runnerLeaseTimeoutMs: this.config.runnerLeaseTimeoutMs,
          logger: this.logger,
        }),
      );
      await this.deps.waitForRunnerReconciliation?.();
      const catchUpReady = this.deps.eventOutboxPump
        ? Promise.resolve(this.deps.eventOutboxPump.connect(async (batch) => {
            await this.sendOnSocket(ws, batch);
          })).then((ready) => ready !== false)
        : Promise.resolve(true);
      // orch-server-ts는 heartbeat ping을 먼저 보내지 않으므로, 허브 ping을 기다리지 않고
      // 등록 직후 노드 쪽에서 능동 시작해야 half-open 연결(원격 서버 리셋 등)을 감지할 수 있다.
      // 양쪽 orch(Python/TS) 모두 노드발 ping에 pong으로 응답한다.
      this.startAppHeartbeat(ws);
      await this.sendInitialSessions(ws);
      const established = await Promise.race([
        Promise.all([registrationPromise, catchUpReady]).then(([, ready]) => ready),
        servePromise.then(() => false),
      ]);
      if (established) {
        this.reconnect.reset();
        this.authWarned = false;
        this.logger.info({ nodeId: this.config.nodeId }, "Registered with upstream");
        await servePromise;
      }
    } finally {
      this.deps.eventOutboxPump?.disconnect();
      if (this.ws === ws) {
        this.ws = null;
      }
    }
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

  private async handleAppHeartbeatMessage(msg: unknown): Promise<boolean> {
    if (!msg || typeof msg !== "object") {
      return false;
    }
    const data = msg as Record<string, unknown>;
    if (data.type === APP_HEARTBEAT_PING) {
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          await this.sendOnSocket(ws, {
            type: APP_HEARTBEAT_PONG,
            sentAt: data.sentAt,
          });
        } catch (err) {
          this.logger.warn({ err }, "Failed to send app heartbeat pong");
        }
      }
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

  private async sendInitialSessions(ws: WebSocket): Promise<void> {
    if (!this.deps.sessionDb) {
      this.logger.warn("sessionDb dependency missing — initial sessions_update skipped");
      return;
    }

    for (let attempt = 1; attempt <= INITIAL_SESSION_REPORT_MAX_ATTEMPTS; attempt += 1) {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        const commands = new SessionListCommands(this.deps.sessionDb, this.config.nodeId);
        const runningSessionIds = await this.listRunningSessionIds(false);
        const report = await commands.listSessions({ requestId: "", runningSessionIds });
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        await this.sendOnSocket(ws, report);
        return;
      } catch (err) {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (attempt === INITIAL_SESSION_REPORT_MAX_ATTEMPTS) {
          this.logger.error(
            { err, attempts: attempt, nodeId: this.config.nodeId },
            "initial sessions_update retry limit exhausted",
          );
          return;
        }
        const delayMs = INITIAL_SESSION_REPORT_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(
          { err, attempt, delayMs, nodeId: this.config.nodeId },
          "initial sessions_update failed — retrying on current connection",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async listRunningSessionIds(waitForReconciliation = true): Promise<string[]> {
    if (waitForReconciliation) await this.deps.waitForRunnerReconciliation?.();
    const inMemorySessionIds = this.deps.taskManager.listTasks()
      .filter((task) => task.status === "running")
      .map((task) => task.agentSessionId);
    return this.deps.listLiveRunnerSessionIds
      ? [...new Set([
          ...inMemorySessionIds,
          ...await this.deps.listLiveRunnerSessionIds(),
        ])]
      : inMemorySessionIds;
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
    await this.commandTransportObserver.send(ws, data);
  }
}

function isNodeRegisterAck(value: unknown, nodeId: string): boolean {
  return Boolean(value && typeof value === "object"
    && (value as Record<string, unknown>).type === "node_register_ack"
    && (value as Record<string, unknown>).node_id === nodeId);
}
