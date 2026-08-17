import type { Socket } from "node:net";

import {
  RunnerFrameSchema,
  isRunnerObservationalFrame,
  type RunnerCommandFrame,
  type RunnerControlFrame,
  type RunnerEventFrame,
  type RunnerFrame,
} from "./frame_protocol.js";
import {
  runnerDroppedFrameSummary,
  type RunnerDroppedFrame,
} from "./runner_frame_drop.js";
import { stripRunnerJsonUndefined } from "./runner_json_contract.js";

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

export interface RunnerIpcConnectionOptions {
  onFrameDropped?(drop: RunnerDroppedFrame): void;
}

export class RunnerObservationDroppedError extends Error {
  constructor() {
    super("Observational runner IPC frame was dropped");
    this.name = "RunnerObservationDroppedError";
  }
}

/** One newline-delimited, JSON-validated runner socket connection. */
export class RunnerIpcConnection {
  private buffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private frameHandler: (frame: RunnerFrame) => Promise<void> = async () => {};
  private failureHandler: (error: Error) => void = () => {};
  // Lifecycle and durable intervention operations use independent FIFOs. A
  // slow engine apply must not starve a receipt stage or an explicit interrupt.
  private stageHandling = Promise.resolve();
  private interventionHandling = Promise.resolve();
  private lifecycleHandling = Promise.resolve();
  private orderedHandling = Promise.resolve();
  private closed = false;
  private droppedFrameCount = 0;

  constructor(
    private readonly socket: Socket,
    private readonly options: RunnerIpcConnectionOptions = {},
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.once("error", (error) => this.fail(normalizeSocketFailure(error)));
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

  async send(frame: RunnerFrame): Promise<boolean> {
    if (this.closed) throw new Error(CONNECTION_CLOSED);
    const observational = isRunnerObservationalFrame(frame);
    const candidate = observational ? stripRunnerJsonUndefined(frame) : frame;
    const result = RunnerFrameSchema.safeParse(candidate);
    if (!result.success) {
      if (!observational) throw result.error;
      const error = new Error("Invalid observational runner IPC frame dropped", {
        cause: result.error,
      });
      this.droppedFrameCount += 1;
      this.options.onFrameDropped?.({
        ...runnerDroppedFrameSummary(frame),
        dropCount: this.droppedFrameCount,
        error,
      });
      return false;
    }
    const parsed = result.data;
    const line = `${JSON.stringify(parsed)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("Runner IPC frame exceeds transport ceiling");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.write(line, (error) => error ? reject(error) : resolve());
    });
    return true;
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
    const responseOutcome = response.then(
      (control) => ({ status: "resolved" as const, control }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      if (!(await this.send(frame))) throw new RunnerObservationDroppedError();
      const outcome = await responseOutcome;
      if (outcome.status === "rejected") throw outcome.error;
      return outcome.control;
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
      switch (priorityLane(frame)) {
        case "stage":
          this.stageHandling = this.enqueueFrame(this.stageHandling, frame);
          break;
        case "intervention":
          this.interventionHandling = this.enqueueFrame(this.interventionHandling, frame);
          break;
        case "lifecycle":
          this.lifecycleHandling = this.enqueueFrame(this.lifecycleHandling, frame);
          break;
        default:
          this.orderedHandling = this.enqueueFrame(this.orderedHandling, frame);
      }
    }
  }

  private enqueueFrame(handling: Promise<void>, frame: RunnerFrame): Promise<void> {
    return handling.then(
      async () => await this.frameHandler(frame),
    ).catch((error: unknown) => this.fail(asError(error)));
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

function priorityLane(
  frame: RunnerFrame,
): "stage" | "intervention" | "lifecycle" | undefined {
  if (frame.channel !== "command") return undefined;
  if (frame.kind === "stage_intervention") return "stage";
  if (frame.kind === "interrupt") return "lifecycle";
  return frame.kind === "invoke"
    && (
      frame.capability === "runner.apply_intervention"
      || frame.capability === "runner.discard_intervention"
    )
    ? "intervention"
    : undefined;
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

function normalizeSocketFailure(error: unknown): Error {
  const normalized = asError(error);
  return process.platform === "win32" &&
    (error as NodeJS.ErrnoException | undefined)?.code === "ECONNRESET"
    ? new Error(CONNECTION_CLOSED, { cause: normalized })
    : normalized;
}
