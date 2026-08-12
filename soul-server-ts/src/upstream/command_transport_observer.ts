import { AsyncLocalStorage } from "node:async_hooks";

import type { Logger } from "pino";
import type { WebSocket } from "ws";

import {
  commandRequestId,
  commandTraceFields,
  type CommandLike,
  type CommandTraceFields,
} from "./command_family.js";

interface InboundCommandTrace extends CommandTraceFields {
  receivedAtMs: number;
  responseSent: boolean;
}

// One second is 1/30 of the orch command timeout: early enough to expose
// starvation before a 30s 503 while leaving ample room for normal local ACKs.
export const SLOW_COMMAND_RESPONSE_THRESHOLD_MS = 1_000;

export class CommandTransportObserver {
  private readonly activeCommand = new AsyncLocalStorage<InboundCommandTrace>();

  constructor(
    private readonly logger: Pick<Logger, "debug" | "warn">,
    private readonly nowMs: () => number = performance.now.bind(performance),
  ) {}

  async observe<T>(
    rawCmd: unknown,
    dispatch: () => Promise<T>,
    expectsResponse?: boolean,
  ): Promise<T> {
    const cmd = (rawCmd ?? {}) as CommandLike;
    const trace = {
      ...commandTraceFields(cmd),
      receivedAtMs: this.nowMs(),
      responseSent: false,
    };
    const shouldExpectResponse = expectsResponse ?? (trace.requestId !== null);
    this.logger.debug(commandTraceFields(cmd), "Upstream command received");
    const pendingWarningTimer = !shouldExpectResponse
      ? null
      : setTimeout(() => {
          if (trace.responseSent) return;
          this.logger.warn(
            {
              type: trace.type,
              requestId: trace.requestId,
              sessionId: trace.sessionId,
              durationMs: this.nowMs() - trace.receivedAtMs,
              slowThresholdMs: SLOW_COMMAND_RESPONSE_THRESHOLD_MS,
            },
            "Upstream command response pending",
          );
        }, SLOW_COMMAND_RESPONSE_THRESHOLD_MS);
    pendingWarningTimer?.unref();
    try {
      return await this.activeCommand.run(trace, dispatch);
    } finally {
      if (pendingWarningTimer) clearTimeout(pendingWarningTimer);
      if (shouldExpectResponse && !trace.responseSent) {
        this.logger.warn(
          {
            type: trace.type,
            requestId: trace.requestId,
            sessionId: trace.sessionId,
            durationMs: this.nowMs() - trace.receivedAtMs,
            slowThresholdMs: SLOW_COMMAND_RESPONSE_THRESHOLD_MS,
          },
          "Upstream command completed without response",
        );
      }
    }
  }

  async send(ws: WebSocket, data: unknown): Promise<void> {
    const serialized = JSON.stringify(data);
    const payloadBytes = serialized === undefined ? 0 : Buffer.byteLength(serialized);
    const bufferedAmountBefore = ws.bufferedAmount;
    const sendStartedAtMs = this.nowMs();
    await new Promise<void>((resolve, reject) => {
      ws.send(serialized, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    const sentAtMs = this.nowMs();
    const trace = this.activeCommand.getStore();
    if (!trace) return;
    // Unrelated event/outbox traffic can inherit the command's async context.
    // Only the matching requestId proves that this command sent its response.
    const outboundRequestId = commandRequestId((data ?? {}) as CommandLike);
    if (trace.requestId === null || outboundRequestId !== trace.requestId) {
      this.logger.debug(
        {
          type: trace.type,
          requestId: trace.requestId,
          sessionId: trace.sessionId,
          outboundRequestId: outboundRequestId || null,
          outboundType: responseType(data),
          payloadBytes,
          webSocketSendElapsedMs: sentAtMs - sendStartedAtMs,
          webSocketBufferedAmountBefore: bufferedAmountBefore,
          webSocketBufferedAmountAfter: ws.bufferedAmount,
        },
        "Uncorrelated upstream send during command",
      );
      return;
    }
    trace.responseSent = true;
    const durationMs = sentAtMs - trace.receivedAtMs;
    const fields = {
      type: trace.type,
      requestId: trace.requestId,
      sessionId: trace.sessionId,
      responseType: responseType(data),
      durationMs,
      slowThresholdMs: SLOW_COMMAND_RESPONSE_THRESHOLD_MS,
      webSocketSendElapsedMs: sentAtMs - sendStartedAtMs,
      payloadBytes,
      webSocketBufferedAmountBefore: bufferedAmountBefore,
      webSocketBufferedAmountAfter: ws.bufferedAmount,
    };
    if (durationMs >= SLOW_COMMAND_RESPONSE_THRESHOLD_MS) {
      this.logger.warn(fields, "Slow upstream command response sent");
    } else {
      this.logger.debug(fields, "Upstream command response sent");
    }
  }
}

function responseType(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const type = (data as Record<string, unknown>).type;
  return typeof type === "string" && type.length > 0 ? type : null;
}
