import { Readable } from "node:stream";

export const SSE_STREAM_HIGH_WATER_MARK = 1024 * 1024;
export const SSE_STREAM_STALL_TIMEOUT_MS = 60_000;

export type SseStreamOptions = {
  readonly highWaterMark?: number;
  readonly stallTimeoutMs?: number;
};

export type SseStreamPush = (chunk: string | Uint8Array) => void;

export function createSseStream(
  options: SseStreamOptions = {},
): { stream: Readable; push: SseStreamPush } {
  const highWaterMark = options.highWaterMark ?? SSE_STREAM_HIGH_WATER_MARK;
  const stallTimeoutMs =
    options.stallTimeoutMs ?? SSE_STREAM_STALL_TIMEOUT_MS;
  assertPositiveInteger(highWaterMark, "highWaterMark");
  assertPositiveInteger(stallTimeoutMs, "stallTimeoutMs");

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const clearStallTimer = () => {
    if (stallTimer === undefined) return;
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const stream = new Readable({
    highWaterMark,
    read() {
      clearStallTimer();
    },
  });
  stream.on("close", clearStallTimer);

  const push: SseStreamPush = (chunk) => {
    if (stream.destroyed) return;
    const accepted = stream.push(chunk);
    if (!accepted && stallTimer === undefined) {
      stallTimer = setTimeout(() => {
        stallTimer = undefined;
        stream.destroy(new Error("sse consumer stalled"));
      }, stallTimeoutMs);
      stallTimer.unref();
    }
  };

  return { stream, push };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`SSE stream ${name} must be a positive integer`);
  }
}
