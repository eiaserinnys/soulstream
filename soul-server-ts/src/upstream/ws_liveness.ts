import { WebSocket } from "ws";

export const DEFAULT_WS_PING_INTERVAL_MS = 15_000;
export const DEFAULT_WS_PING_MISS_LIMIT = 2;

export type WsLivenessOptions = {
  intervalMs?: number;
  missLimit?: number;
};

type LivenessSocket = Pick<
  WebSocket,
  "ping" | "terminate" | "readyState" | "on" | "once" | "off"
>;

/**
 * Keeps a node-side WebSocket honest with protocol pings. A pong resets the
 * miss count; `missLimit` consecutive intervals without one terminate the
 * socket, which lets the existing close handler reconnect. The timer stops on
 * close and on the returned stop function.
 */
export function attachWsLiveness(
  socket: LivenessSocket,
  options: WsLivenessOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_WS_PING_INTERVAL_MS;
  const missLimit = options.missLimit ?? DEFAULT_WS_PING_MISS_LIMIT;
  let missedPongs = 0;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off("pong", onPong);
    socket.off("close", stop);
  };
  const onPong = (): void => {
    missedPongs = 0;
  };
  const timer = setInterval(() => {
    if (stopped) return;
    if (missedPongs >= missLimit) {
      stop();
      try {
        socket.terminate();
      } catch {
        // The close handler owns the reconnect path.
      }
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    missedPongs += 1;
    try {
      socket.ping();
    } catch {
      // The close handler owns the reconnect path.
    }
  }, intervalMs);
  socket.on("pong", onPong);
  socket.once("close", stop);
  return stop;
}
