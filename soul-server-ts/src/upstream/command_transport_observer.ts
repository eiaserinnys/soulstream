import { AsyncLocalStorage } from "node:async_hooks";

import type { Logger } from "pino";
import type { WebSocket } from "ws";

import {
  commandTraceFields,
  type CommandLike,
  type CommandTraceFields,
} from "./command_family.js";

interface InboundCommandTrace extends CommandTraceFields {
  receivedAtMs: number;
}

export class CommandTransportObserver {
  private readonly activeCommand = new AsyncLocalStorage<InboundCommandTrace>();

  constructor(
    private readonly logger: Pick<Logger, "debug">,
    private readonly nowMs: () => number = performance.now.bind(performance),
  ) {}

  async observe<T>(rawCmd: unknown, dispatch: () => Promise<T>): Promise<T> {
    const cmd = (rawCmd ?? {}) as CommandLike;
    const trace = {
      ...commandTraceFields(cmd),
      receivedAtMs: this.nowMs(),
    };
    this.logger.debug(commandTraceFields(cmd), "Upstream command received");
    return await this.activeCommand.run(trace, dispatch);
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
    this.logger.debug(
      {
        type: trace.type,
        requestId: trace.requestId,
        sessionId: trace.sessionId,
        responseType: responseType(data),
        elapsedMs: sentAtMs - trace.receivedAtMs,
        webSocketSendElapsedMs: sentAtMs - sendStartedAtMs,
        payloadBytes,
        webSocketBufferedAmountBefore: bufferedAmountBefore,
        webSocketBufferedAmountAfter: ws.bufferedAmount,
      },
      "Upstream command response sent",
    );
  }
}

function responseType(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const type = (data as Record<string, unknown>).type;
  return typeof type === "string" && type.length > 0 ? type : null;
}
