import {
  RunnerControlFrameSchema,
  RunnerEventFrameSchema,
  isRunnerObservationalFrame,
  type RunnerControlFrame,
  type RunnerEventFrame,
} from "./frame_protocol.js";
import {
  runnerDroppedFrameSummary,
  type RunnerDroppedFrame,
} from "./runner_frame_drop.js";
import { stripRunnerJsonUndefined } from "./runner_json_contract.js";

interface PendingFrame {
  frame: RunnerEventFrame;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface NextWaiter {
  resolve: (result: IteratorResult<RunnerEventFrame>) => void;
  reject: (error: Error) => void;
}

interface PendingControl {
  resolve: (frame: RunnerControlFrame) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  timeoutMs: number;
  abort: (error: Error) => void;
  cleanup: () => void;
}

const CHANNEL_CLOSED_MESSAGE = "In-process runner frame channel closed";
export const DEFAULT_RUNNER_REQUEST_TIMEOUT_MS = 30_000;

export interface RunnerFrameRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface InProcessRunnerFrameChannelOptions {
  onFrameDropped?(drop: RunnerDroppedFrame): void;
}

/**
 * Acknowledged in-process transport for the future runner IPC contract.
 *
 * `emit()` resolves only after the consumer has processed the frame and asks
 * for the next one. That preserves the await/order semantics of the callbacks
 * this channel replaces. `request()` additionally waits for one correlated
 * control response.
 */
export class InProcessRunnerFrameChannel implements AsyncIterable<RunnerEventFrame> {
  private droppedFrameCount = 0;
  private readonly queued: PendingFrame[] = [];
  private readonly pendingControls = new Map<string, PendingControl>();
  private delivered: PendingFrame | undefined;
  private waiter: NextWaiter | undefined;
  private failure: Error | undefined;
  private finished = false;
  private started = false;
  private consumerClosed = false;

  constructor(private readonly options: InProcessRunnerFrameChannelOptions = {}) {}

  start(producer: () => Promise<void>): void {
    if (this.started) {
      throw new Error("In-process runner frame producer already started");
    }
    this.started = true;
    void producer().then(
      () => this.finish(),
      (error: unknown) => this.fail(asError(error)),
    );
  }

  emit(frame: RunnerEventFrame): Promise<void> {
    if (this.consumerClosed || this.finished || this.failure) {
      return Promise.reject(this.failure ?? new Error(CHANNEL_CLOSED_MESSAGE));
    }
    const observational = isRunnerObservationalFrame(frame);
    const candidate = observational ? stripRunnerJsonUndefined(frame) : frame;
    const result = RunnerEventFrameSchema.safeParse(candidate);
    if (!result.success) {
      if (!observational) return Promise.reject(result.error);
      this.droppedFrameCount += 1;
      this.options.onFrameDropped?.({
        ...runnerDroppedFrameSummary(frame),
        dropCount: this.droppedFrameCount,
        error: new Error("Invalid observational in-process runner frame dropped", {
          cause: result.error,
        }),
      });
      return Promise.resolve();
    }
    const parsed = result.data;
    return new Promise<void>((resolve, reject) => {
      const pending = { frame: parsed, resolve, reject };
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        this.delivered = pending;
        waiter.resolve({ value: parsed, done: false });
        return;
      }
      this.queued.push(pending);
    });
  }

  async request(
    frame: Extract<RunnerEventFrame, { kind: "request" }>,
    options: RunnerFrameRequestOptions = {},
  ): Promise<RunnerControlFrame> {
    if (this.pendingControls.has(frame.correlationId)) {
      throw new Error(`Duplicate runner correlation id: ${frame.correlationId}`);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Runner request timeoutMs must be a positive integer: ${timeoutMs}`);
    }
    const lifetime = createRequestLifetime(options.signal, timeoutMs);
    if (lifetime.signal.aborted) {
      lifetime.cleanup();
      throw abortReason(lifetime.signal);
    }
    let pending!: PendingControl;
    const response = new Promise<RunnerControlFrame>((resolve, reject) => {
      const rejectOnAbort = () => reject(abortReason(lifetime.signal));
      lifetime.signal.addEventListener("abort", rejectOnAbort, { once: true });
      pending = {
        resolve,
        reject,
        signal: lifetime.signal,
        timeoutMs,
        abort: lifetime.abort,
        cleanup: () => {
          lifetime.signal.removeEventListener("abort", rejectOnAbort);
          lifetime.cleanup();
        },
      };
    });
    this.pendingControls.set(frame.correlationId, pending);
    try {
      const [, control] = await Promise.all([this.emit(frame), response]);
      return control;
    } finally {
      if (pending.signal.aborted) {
        this.cancelRequestFrame(frame.correlationId, abortReason(pending.signal));
      }
      if (this.pendingControls.get(frame.correlationId) === pending) {
        this.pendingControls.delete(frame.correlationId);
      }
      pending.cleanup();
    }
  }

  requestContext(correlationId: string): {
    signal: AbortSignal;
    timeoutMs: number;
  } | undefined {
    const pending = this.pendingControls.get(correlationId);
    return pending
      ? { signal: pending.signal, timeoutMs: pending.timeoutMs }
      : undefined;
  }

  get pendingControlCount(): number {
    return this.pendingControls.size;
  }

  sendControl(frame: RunnerControlFrame): boolean {
    const parsed = RunnerControlFrameSchema.parse(frame);
    if (
      parsed.kind === "command_result"
      || parsed.kind === "execution_ended"
      || parsed.kind === "outbox_available"
      || parsed.kind === "host_frame_applied"
    ) return false;
    const pending = this.pendingControls.get(parsed.correlationId);
    if (!pending) return false;
    this.pendingControls.delete(parsed.correlationId);
    pending.cleanup();
    pending.resolve(parsed);
    return true;
  }

  [Symbol.asyncIterator](): AsyncIterator<RunnerEventFrame> {
    return {
      next: () => this.next(),
      return: () => this.closeConsumer(),
    };
  }

  private async next(): Promise<IteratorResult<RunnerEventFrame>> {
    if (this.consumerClosed) return { value: undefined, done: true };
    this.ackDelivered();

    const pending = this.queued.shift();
    if (pending) {
      this.delivered = pending;
      return { value: pending.frame, done: false };
    }
    if (this.failure) throw this.failure;
    if (this.finished) return { value: undefined, done: true };
    if (this.waiter) {
      throw new Error("Concurrent runner frame reads are not supported");
    }
    return new Promise<IteratorResult<RunnerEventFrame>>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private finish(): void {
    if (this.finished || this.failure) return;
    this.finished = true;
    this.rejectPendingControls(new Error(CHANNEL_CLOSED_MESSAGE));
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.finished) return;
    this.failure = error;
    this.rejectPendingControls(error);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.reject(error);
    }
  }

  private async closeConsumer(): Promise<IteratorResult<RunnerEventFrame>> {
    if (this.consumerClosed) return { value: undefined, done: true };
    this.consumerClosed = true;
    this.ackDelivered();
    const error = new Error(CHANNEL_CLOSED_MESSAGE);
    for (const pending of this.queued.splice(0)) pending.reject(error);
    this.rejectPendingControls(error);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: undefined, done: true });
    }
    return { value: undefined, done: true };
  }

  private ackDelivered(): void {
    if (!this.delivered) return;
    const delivered = this.delivered;
    this.delivered = undefined;
    delivered.resolve();
  }

  private cancelRequestFrame(correlationId: string, error: Error): void {
    const queuedIndex = this.queued.findIndex(
      ({ frame }) => frame.kind === "request" && frame.correlationId === correlationId,
    );
    if (queuedIndex >= 0) {
      this.queued.splice(queuedIndex, 1)[0]?.reject(error);
    }
    if (
      this.delivered?.frame.kind === "request"
      && this.delivered.frame.correlationId === correlationId
    ) {
      const delivered = this.delivered;
      this.delivered = undefined;
      delivered.reject(error);
    }
  }

  private rejectPendingControls(error: Error): void {
    for (const pending of this.pendingControls.values()) {
      pending.abort(error);
      pending.reject(error);
      pending.cleanup();
    }
    this.pendingControls.clear();
  }
}

function createRequestLifetime(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  abort: (error: Error) => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = (error: Error) => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  const abortFromParent = () => abort(abortReason(parent!));
  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(
    () => abort(new Error(`Runner request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    abort,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason ? String(signal.reason) : "Runner request aborted");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
