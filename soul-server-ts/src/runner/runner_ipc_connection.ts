import type { Socket } from "node:net";

import {
  RunnerFrameSchema,
  type RunnerCommandFrame,
  type RunnerControlFrame,
  type RunnerEventFrame,
  type RunnerFrame,
} from "./frame_protocol.js";

const MAX_FRAME_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const CONNECTION_CLOSED = "Runner IPC connection closed";

export interface RunnerIpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

interface PendingRequest {
  resolve(frame: RunnerControlFrame): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** One newline-delimited, JSON-validated runner socket connection. */
export class RunnerIpcConnection {
  private buffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private frameHandler: (frame: RunnerFrame) => Promise<void> = async () => {};
  private failureHandler: (error: Error) => void = () => {};
  private handling = Promise.resolve();
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.once("error", (error) => this.fail(asError(error)));
    socket.once("close", () => this.fail(new Error(CONNECTION_CLOSED)));
  }

  onFrame(handler: (frame: RunnerFrame) => Promise<void> | void): void {
    this.frameHandler = async (frame) => await handler(frame);
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  async send(frame: RunnerFrame): Promise<void> {
    if (this.closed) throw new Error(CONNECTION_CLOSED);
    const parsed = RunnerFrameSchema.parse(frame);
    const line = `${JSON.stringify(parsed)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("Runner IPC frame exceeds transport ceiling");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.write(line, (error) => error ? reject(error) : resolve());
    });
  }

  async request(
    frame: RunnerCommandFrame | Extract<RunnerEventFrame, { kind: "request" }>,
    options: RunnerIpcRequestOptions,
  ): Promise<RunnerControlFrame> {
    const key = requestKey(frame);
    if (this.pending.has(key)) throw new Error(`Duplicate runner IPC request: ${key}`);
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Runner IPC timeoutMs must be a positive integer");
    }
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(abortReason(options.signal!));
    if (options.signal?.aborted) abortFromParent();
    else options.signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`Runner IPC request timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    timer.unref?.();
    if (controller.signal.aborted) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromParent);
      throw abortReason(controller.signal);
    }

    let pending!: PendingRequest;
    const response = new Promise<RunnerControlFrame>((resolve, reject) => {
      const rejectOnAbort = () => reject(abortReason(controller.signal));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      pending = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abortFromParent);
          controller.signal.removeEventListener("abort", rejectOnAbort);
        },
      };
    });
    this.pending.set(key, pending);
    try {
      const [, control] = await Promise.all([this.send(frame), response]);
      return control;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
      pending.cleanup();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.rejectPending(new Error(CONNECTION_CLOSED));
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
      this.fail(new Error("Runner IPC frame exceeds transport ceiling"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: RunnerFrame;
      try {
        frame = RunnerFrameSchema.parse(JSON.parse(line));
      } catch (error) {
        this.fail(new Error("Invalid runner IPC frame", { cause: error }));
        return;
      }
      if (frame.channel === "control" && this.resolvePending(frame)) continue;
      this.handling = this.handling.then(
        async () => await this.frameHandler(frame),
      ).catch((error: unknown) => this.fail(asError(error)));
    }
  }

  private resolvePending(frame: RunnerControlFrame): boolean {
    const key = responseKey(frame);
    if (!key) return false;
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    pending.cleanup();
    pending.resolve(frame);
    return true;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
    this.failureHandler(error);
    this.socket.destroy();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function requestKey(frame: RunnerCommandFrame | Extract<RunnerEventFrame, { kind: "request" }>): string {
  return frame.channel === "command"
    ? `command:${frame.commandId}`
    : `request:${frame.correlationId}`;
}

function responseKey(frame: RunnerControlFrame): string | undefined {
  if (frame.kind === "command_result") return `command:${frame.commandId}`;
  if (frame.kind === "response") return `request:${frame.correlationId}`;
  return undefined;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason ? String(signal.reason) : "Runner IPC request aborted");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
