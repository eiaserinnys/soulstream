import {
  RunnerControlFrameSchema,
  RunnerEventFrameSchema,
  type RunnerControlFrame,
  type RunnerEventFrame,
} from "./frame_protocol.js";

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
}

const CHANNEL_CLOSED_MESSAGE = "In-process runner frame channel closed";

/**
 * Acknowledged in-process transport for the future runner IPC contract.
 *
 * `emit()` resolves only after the consumer has processed the frame and asks
 * for the next one. That preserves the await/order semantics of the callbacks
 * this channel replaces. `request()` additionally waits for one correlated
 * control response.
 */
export class InProcessRunnerFrameChannel implements AsyncIterable<RunnerEventFrame> {
  private readonly queued: PendingFrame[] = [];
  private readonly pendingControls = new Map<string, PendingControl>();
  private delivered: PendingFrame | undefined;
  private waiter: NextWaiter | undefined;
  private failure: Error | undefined;
  private finished = false;
  private started = false;
  private consumerClosed = false;

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
    const parsed = RunnerEventFrameSchema.parse(frame);
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
  ): Promise<RunnerControlFrame> {
    if (this.pendingControls.has(frame.correlationId)) {
      throw new Error(`Duplicate runner correlation id: ${frame.correlationId}`);
    }
    let pending!: PendingControl;
    const response = new Promise<RunnerControlFrame>((resolve, reject) => {
      pending = { resolve, reject };
    });
    this.pendingControls.set(frame.correlationId, pending);
    try {
      const [, control] = await Promise.all([this.emit(frame), response]);
      return control;
    } finally {
      if (this.pendingControls.get(frame.correlationId) === pending) {
        this.pendingControls.delete(frame.correlationId);
      }
    }
  }

  sendControl(frame: RunnerControlFrame): boolean {
    const parsed = RunnerControlFrameSchema.parse(frame);
    const pending = this.pendingControls.get(parsed.correlationId);
    if (!pending) return false;
    this.pendingControls.delete(parsed.correlationId);
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

  private rejectPendingControls(error: Error): void {
    for (const pending of this.pendingControls.values()) pending.reject(error);
    this.pendingControls.clear();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
