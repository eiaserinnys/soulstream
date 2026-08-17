export type ClaudeForegroundPhase =
  | "idle"
  | "generating"
  | "interrupting"
  | "turn_result"
  | "drain";

export type ClaudeQueryLifecycle = "open" | "closed" | "fatal";

export type ClaudeRuntimeCloseReason =
  | "explicit_cancel"
  | "session_delete"
  | "registry_ttl"
  | "registry_capacity"
  | "shutdown"
  | "worker_restart"
  | "backend_rollover"
  | "followup_no_output"
  | "fatal";

export type ClaudeInputState =
  | "queued"
  | "submitted"
  | "receipt_still_queued"
  | "settled";

export type ClaudeDetachedResultObservation =
  | "settled"
  | "duplicate"
  | "unknown";

export interface ClaudeRuntimeInput<TMessage> {
  uuid: string;
  payloadHash: string;
  message: TMessage;
}

export interface ClaudeInputRecord {
  uuid: string;
  payloadHash: string;
  state: ClaudeInputState;
}

export interface ClaudeInterruptReceipt {
  still_queued?: string[];
}

export interface ClaudePersistentQuery {
  interrupt(): Promise<ClaudeInterruptReceipt | undefined>;
  close(): void;
}

export interface ClaudeSessionRuntimeSnapshot {
  sessionId: string | null;
  foregroundPhase: ClaudeForegroundPhase;
  queryLifecycle: ClaudeQueryLifecycle;
  pendingInputs: ClaudeInputRecord[];
  backgroundTaskIds: string[];
  interruptReceiptObserved: boolean;
  interruptedResultObserved: boolean;
}

export interface ClaudePersistentRuntimeActivity {
  foregroundPhase: ClaudeForegroundPhase;
  queryLifecycle: ClaudeQueryLifecycle;
  backgroundTaskCount: number;
  pendingInputRequestCount: number;
  pendingRuntimeSignalCount?: number;
}

/**
 * Async input queue owned by one persistent Claude Query.
 *
 * Result messages do not close this iterator. Only ClaudeSessionRuntime.close()
 * does, so foreground turns and background runtime share one stable Query.
 */
export class ClaudeSessionInputQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined as T });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.closed) return { done: true, value: undefined as T };
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { done: true, value: undefined as T };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

/**
 * Persistent Claude session ownership model.
 *
 * The runtime is the default Claude path and is disconnected only by the
 * explicit legacy kill switch. It owns the
 * contracts measured by the SDK harness:
 * one Query, one input queue, UUID-local exactly-once state, and a background
 * replace-set orthogonal to the foreground turn phase.
 */
export class ClaudeSessionRuntime<TMessage> {
  readonly inputQueue = new ClaudeSessionInputQueue<TMessage>();
  readonly query: ClaudePersistentQuery;

  private sessionId: string | null = null;
  private foregroundPhase: ClaudeForegroundPhase = "idle";
  private queryLifecycle: ClaudeQueryLifecycle = "open";
  private readonly inputs = new Map<string, ClaudeInputRecord>();
  private readonly backgroundTaskIds = new Set<string>();
  private interruptReceiptObserved = false;
  private interruptedResultObserved = false;

  constructor(
    createQuery: (input: AsyncIterable<TMessage>) => ClaudePersistentQuery,
  ) {
    this.query = createQuery(this.inputQueue);
  }

  setSessionId(sessionId: string): void {
    if (this.sessionId && this.sessionId !== sessionId) {
      throw new Error(
        `Persistent Claude Query changed session id: ${this.sessionId} -> ${sessionId}`,
      );
    }
    this.sessionId = sessionId;
  }

  enqueueInput(input: ClaudeRuntimeInput<TMessage>): boolean {
    this.assertOpen();
    const existing = this.inputs.get(input.uuid);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        throw new Error(`Claude input UUID conflict: ${input.uuid}`);
      }
      return false;
    }
    this.inputs.set(input.uuid, {
      uuid: input.uuid,
      payloadHash: input.payloadHash,
      state: "queued",
    });
    if (!this.inputQueue.push(input.message)) {
      this.inputs.delete(input.uuid);
      throw new Error("Persistent Claude input queue is closed");
    }
    return true;
  }

  beginForegroundTurn(uuid: string): void {
    this.assertOpen();
    if (
      this.foregroundPhase !== "idle" &&
      this.foregroundPhase !== "turn_result" &&
      this.foregroundPhase !== "drain"
    ) {
      throw new Error(`Cannot begin Claude turn while ${this.foregroundPhase}`);
    }
    const input = this.requireInput(uuid);
    if (input.state === "settled") {
      throw new Error(`Claude input already settled: ${uuid}`);
    }
    input.state = "submitted";
    this.foregroundPhase = "generating";
    this.interruptReceiptObserved = false;
    this.interruptedResultObserved = false;
  }

  async interruptThenDeliver(
    input: ClaudeRuntimeInput<TMessage>,
  ): Promise<ClaudeInterruptReceipt> {
    this.assertOpen();
    this.enqueueInput(input);
    return await this.interruptForeground();
  }

  async interruptForeground(): Promise<ClaudeInterruptReceipt> {
    this.assertOpen();
    if (this.foregroundPhase !== "generating") {
      throw new Error(`Cannot interrupt Claude turn while ${this.foregroundPhase}`);
    }
    this.foregroundPhase = "interrupting";
    const receipt = await this.query.interrupt() ?? {};
    this.observeInterruptReceipt(receipt);
    return receipt;
  }

  observeInterruptReceipt(receipt: ClaudeInterruptReceipt): void {
    if (this.foregroundPhase !== "interrupting") {
      throw new Error(`Unexpected Claude interrupt receipt while ${this.foregroundPhase}`);
    }
    this.interruptReceiptObserved = true;
    for (const uuid of receipt.still_queued ?? []) {
      const input = this.inputs.get(uuid);
      if (input && input.state !== "settled") {
        input.state = "receipt_still_queued";
      }
    }
    // L0: receipt omission is not delivery evidence. Missing UUIDs stay local.
  }

  observeResult(params: {
    userMessageUuid?: string;
    interrupted: boolean;
  }): void {
    this.assertOpen();
    if (params.userMessageUuid) {
      const input = this.inputs.get(params.userMessageUuid);
      if (input) input.state = "settled";
    }
    this.interruptedResultObserved = params.interrupted;
    this.foregroundPhase = "turn_result";
  }

  observeDetachedResult(userMessageUuid: string): ClaudeDetachedResultObservation {
    this.assertOpen();
    const input = this.inputs.get(userMessageUuid);
    if (!input) return "unknown";
    if (input.state === "settled") return "duplicate";
    input.state = "settled";
    return "settled";
  }

  finishForegroundResult(): void {
    this.assertOpen();
    if (this.foregroundPhase !== "turn_result") {
      throw new Error(`Cannot finish Claude result while ${this.foregroundPhase}`);
    }
    this.foregroundPhase = "drain";
  }

  finishDrain(): void {
    this.assertOpen();
    if (this.foregroundPhase === "drain") {
      this.foregroundPhase = "idle";
    }
  }

  replaceBackgroundTasks(taskIds: Iterable<string>): void {
    this.backgroundTaskIds.clear();
    for (const taskId of taskIds) this.backgroundTaskIds.add(taskId);
  }

  observeBackgroundTask(taskId: string, terminal: boolean): void {
    if (terminal) {
      this.backgroundTaskIds.delete(taskId);
      return;
    }
    this.backgroundTaskIds.add(taskId);
  }

  close(reason: ClaudeRuntimeCloseReason): void {
    if (this.queryLifecycle !== "open") return;
    this.queryLifecycle = reason === "fatal" ? "fatal" : "closed";
    this.inputQueue.close();
    this.query.close();
  }

  snapshot(): ClaudeSessionRuntimeSnapshot {
    return {
      sessionId: this.sessionId,
      foregroundPhase: this.foregroundPhase,
      queryLifecycle: this.queryLifecycle,
      pendingInputs: Array.from(this.inputs.values()).map((input) => ({ ...input })),
      backgroundTaskIds: Array.from(this.backgroundTaskIds).sort(),
      interruptReceiptObserved: this.interruptReceiptObserved,
      interruptedResultObserved: this.interruptedResultObserved,
    };
  }

  private requireInput(uuid: string): ClaudeInputRecord {
    const input = this.inputs.get(uuid);
    if (!input) throw new Error(`Unknown Claude input UUID: ${uuid}`);
    return input;
  }

  private assertOpen(): void {
    if (this.queryLifecycle !== "open") {
      throw new Error(`Persistent Claude Query is ${this.queryLifecycle}`);
    }
  }
}
