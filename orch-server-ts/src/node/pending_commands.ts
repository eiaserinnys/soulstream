export const DEFAULT_NODE_COMMAND_TIMEOUT_MS = 30_000;

export type NodeCommandClock = () => number;

export type NodeCommandScheduler = {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
};

export type NodeCommandRequestIdContext = {
  readonly sequence: number;
  readonly commandType: string;
  readonly nowMs: number;
};

export type NodeCommandRequestIdGenerator = (
  context: NodeCommandRequestIdContext,
) => string;

export type RequestResponseNodeCommandPayload<TType extends string = string> = {
  type: TType;
  requestId?: never;
  fireAndForget?: never;
  [key: string]: unknown;
};

export type FireAndForgetNodeCommandPayload<TType extends string = string> = {
  type: TType;
  requestId?: never;
  [key: string]: unknown;
};

export type RespondNodeCommandPayload = RequestResponseNodeCommandPayload<"respond"> & {
  agentSessionId: string;
  inputRequestId: string;
  answers: Record<string, unknown>;
};

export type SubscribeEventsNodeCommandPayload =
  FireAndForgetNodeCommandPayload<"subscribe_events"> & {
    agentSessionId: string;
    subscribeId: string;
  };

export type NodeCommandEnvelope<TPayload extends RequestResponseNodeCommandPayload> =
  Omit<TPayload, "requestId" | "fireAndForget"> & {
    requestId: string;
  };

export type NodeFireAndForgetCommand<TPayload extends FireAndForgetNodeCommandPayload> = {
  fireAndForget: true;
  message: Omit<TPayload, "requestId">;
};

export type NodeCommandResponse = {
  type: string;
  requestId?: string;
  message?: string;
  [key: string]: unknown;
};

export type PendingNodeCommand<
  TPayload extends RequestResponseNodeCommandPayload = RequestResponseNodeCommandPayload,
  TResponse extends NodeCommandResponse = NodeCommandResponse,
> = {
  fireAndForget: false;
  requestId: string;
  commandType: TPayload["type"];
  message: NodeCommandEnvelope<TPayload>;
  result: Promise<TResponse>;
  createdAtMs: number;
  expiresAtMs: number;
  timeoutMs: number;
};

export type PendingNodeCommandEntry = {
  requestId: string;
  commandType: string;
  createdAtMs: number;
  expiresAtMs: number;
  timeoutMs: number;
};

export type PendingNodeCommandSettlement =
  | {
      status: "resolved";
      requestId: string;
      commandType: string;
    }
  | {
      status: "rejected";
      requestId: string;
      commandType: string;
      message: string;
    }
  | {
      status: "ignored";
      reason: "missing_request_id" | "unknown_request_id";
      requestId?: string;
    };

export type PendingNodeCommandTimeout = {
  requestId: string;
  commandType: string;
  timeoutMs: number;
  createdAtMs: number;
  expiresAtMs: number;
};

export type PendingNodeCommandsOptions = {
  defaultTimeoutMs?: number;
  nowMs?: NodeCommandClock;
  requestIdGenerator?: NodeCommandRequestIdGenerator;
  scheduler?: NodeCommandScheduler;
};

type Deferred<TValue> = {
  promise: Promise<TValue>;
  resolve: (value: TValue) => void;
  reject: (reason: unknown) => void;
};

type MutablePendingEntry = PendingNodeCommandEntry & {
  resolve: (response: NodeCommandResponse) => void;
  reject: (reason: unknown) => void;
  timerHandle: unknown;
};

export class PendingNodeCommandRejectedError extends Error {
  readonly commandType: string;
  readonly requestId: string;
  readonly response: NodeCommandResponse | undefined;

  constructor(params: {
    commandType: string;
    requestId: string;
    message: string;
    response?: NodeCommandResponse;
  }) {
    super(params.message);
    this.name = "PendingNodeCommandRejectedError";
    this.commandType = params.commandType;
    this.requestId = params.requestId;
    this.response = params.response;
  }
}

export class PendingNodeCommandTimeoutError extends Error {
  readonly commandType: string;
  readonly requestId: string;
  readonly timeoutMs: number;

  constructor(params: {
    commandType: string;
    requestId: string;
    timeoutMs: number;
  }) {
    super(
      `Command ${params.commandType} timed out after ${params.timeoutMs}ms ` +
        `(requestId=${params.requestId})`,
    );
    this.name = "PendingNodeCommandTimeoutError";
    this.commandType = params.commandType;
    this.requestId = params.requestId;
    this.timeoutMs = params.timeoutMs;
  }
}

export function defaultNodeCommandRequestIdGenerator(
  context: NodeCommandRequestIdContext,
): string {
  return `req-${context.sequence}-${context.nowMs}`;
}

export class PendingNodeCommands {
  readonly defaultTimeoutMs: number;

  private readonly nowMs: NodeCommandClock;
  private readonly requestIdGenerator: NodeCommandRequestIdGenerator;
  private readonly scheduler: NodeCommandScheduler;
  private readonly pending = new Map<string, MutablePendingEntry>();
  private requestSequence = 0;

  constructor(options: PendingNodeCommandsOptions = {}) {
    const defaultTimeoutMs =
      options.defaultTimeoutMs ?? DEFAULT_NODE_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new Error(
        `defaultTimeoutMs must be a positive integer: ${defaultTimeoutMs}`,
      );
    }

    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nowMs = options.nowMs ?? Date.now;
    this.requestIdGenerator =
      options.requestIdGenerator ?? defaultNodeCommandRequestIdGenerator;
    this.scheduler = options.scheduler ?? defaultNodeCommandScheduler;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  get pendingEntries(): PendingNodeCommandEntry[] {
    return [...this.pending.values()].map((entry) => ({
      requestId: entry.requestId,
      commandType: entry.commandType,
      createdAtMs: entry.createdAtMs,
      expiresAtMs: entry.expiresAtMs,
      timeoutMs: entry.timeoutMs,
    }));
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  createCommand<
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    payload: TPayload,
    options: { timeoutMs?: number } = {},
  ): PendingNodeCommand<TPayload, TResponse> {
    assertNoReservedRequestId(payload);
    assertNoFireAndForgetMarker(payload);

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`timeoutMs must be a positive integer: ${timeoutMs}`);
    }

    const createdAtMs = this.nowMs();
    const requestId = this.nextRequestId(payload.type, createdAtMs);
    const expiresAtMs = createdAtMs + timeoutMs;
    const deferred = createDeferred<NodeCommandResponse>();

    const entry: MutablePendingEntry = {
      requestId,
      commandType: payload.type,
      createdAtMs,
      expiresAtMs,
      timeoutMs,
      resolve: deferred.resolve,
      reject: deferred.reject,
      timerHandle: undefined,
    };
    this.pending.set(requestId, entry);
    entry.timerHandle = this.scheduler.set(() => {
      this.timeout(requestId);
    }, timeoutMs);

    return {
      fireAndForget: false,
      requestId,
      commandType: payload.type,
      message: {
        ...payload,
        requestId,
      } as NodeCommandEnvelope<TPayload>,
      result: deferred.promise as Promise<TResponse>,
      createdAtMs,
      expiresAtMs,
      timeoutMs,
    };
  }

  createFireAndForgetCommand<TPayload extends FireAndForgetNodeCommandPayload>(
    payload: TPayload,
  ): NodeFireAndForgetCommand<TPayload> {
    assertNoReservedRequestId(payload);

    return {
      fireAndForget: true,
      message: { ...payload } as Omit<TPayload, "requestId">,
    };
  }

  resolve(requestId: string, response: NodeCommandResponse): boolean {
    const entry = this.take(requestId);
    if (entry === undefined) return false;

    entry.resolve(response);
    return true;
  }

  reject(
    requestId: string,
    message: string,
    response?: NodeCommandResponse,
  ): boolean {
    const entry = this.take(requestId);
    if (entry === undefined) return false;

    entry.reject(
      new PendingNodeCommandRejectedError({
        commandType: entry.commandType,
        requestId,
        message,
        response,
      }),
    );
    return true;
  }

  rejectAll(message: string, response?: NodeCommandResponse): PendingNodeCommandEntry[] {
    const entries = this.pendingEntries;
    for (const entry of entries) {
      this.reject(entry.requestId, message, response);
    }
    return entries;
  }

  settleFromResponse(response: NodeCommandResponse): PendingNodeCommandSettlement {
    const requestId =
      typeof response.requestId === "string" && response.requestId.length > 0
        ? response.requestId
        : undefined;
    if (requestId === undefined) {
      return {
        status: "ignored",
        reason: "missing_request_id",
      };
    }

    const entry = this.pending.get(requestId);
    if (entry === undefined) {
      return {
        status: "ignored",
        reason: "unknown_request_id",
        requestId,
      };
    }

    if (response.type === "error") {
      const message =
        typeof response.message === "string" ? response.message : "Unknown error";
      this.reject(requestId, message, response);
      return {
        status: "rejected",
        requestId,
        commandType: entry.commandType,
        message,
      };
    }

    this.resolve(requestId, response);
    return {
      status: "resolved",
      requestId,
      commandType: entry.commandType,
    };
  }

  sweepExpired(nowMs = this.nowMs()): PendingNodeCommandTimeout[] {
    const expired: PendingNodeCommandTimeout[] = [];

    for (const entry of this.pending.values()) {
      if (nowMs < entry.expiresAtMs) continue;

      const expiredEntry = this.take(entry.requestId);
      if (expiredEntry === undefined) continue;
      expiredEntry.reject(
        new PendingNodeCommandTimeoutError({
          commandType: expiredEntry.commandType,
          requestId: expiredEntry.requestId,
          timeoutMs: expiredEntry.timeoutMs,
        }),
      );
      expired.push({
        requestId: entry.requestId,
        commandType: entry.commandType,
        timeoutMs: entry.timeoutMs,
        createdAtMs: entry.createdAtMs,
        expiresAtMs: entry.expiresAtMs,
      });
    }

    return expired;
  }

  private timeout(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    this.pending.delete(requestId);
    entry.reject(
      new PendingNodeCommandTimeoutError({
        commandType: entry.commandType,
        requestId: entry.requestId,
        timeoutMs: entry.timeoutMs,
      }),
    );
  }

  private take(requestId: string): MutablePendingEntry | undefined {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return undefined;
    this.pending.delete(requestId);
    this.scheduler.clear(entry.timerHandle);
    return entry;
  }

  private nextRequestId(commandType: string, nowMs: number): string {
    this.requestSequence += 1;
    const requestId = this.requestIdGenerator({
      sequence: this.requestSequence,
      commandType,
      nowMs,
    });

    if (requestId.length === 0) {
      throw new Error("requestIdGenerator returned an empty request id");
    }
    if (this.pending.has(requestId)) {
      throw new Error(`requestIdGenerator returned a duplicate request id: ${requestId}`);
    }
    return requestId;
  }
}

const defaultNodeCommandScheduler: NodeCommandScheduler = {
  set: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function createDeferred<TValue>(): Deferred<TValue> {
  let resolve!: (value: TValue) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assertNoReservedRequestId(payload: object): void {
  if (Object.prototype.hasOwnProperty.call(payload, "requestId")) {
    throw new Error(
      "requestId is reserved for node command correlation; use inputRequestId " +
        "for respond/input_request correlation.",
    );
  }
}

function assertNoFireAndForgetMarker(payload: object): void {
  if (Object.prototype.hasOwnProperty.call(payload, "fireAndForget")) {
    throw new Error(
      "fireAndForget is command model metadata; use createFireAndForgetCommand.",
    );
  }
}
