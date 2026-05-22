import type {
  AppServerRequestId,
  AppServerServerRequest,
  CodexAppServerMethod,
  CodexAppServerMethodMap,
  CodexAppServerRequest,
  JsonValue,
} from "./protocol.js";

export type AppServerJsonMessage = { [key: string]: unknown };

export interface AppServerTransport {
  send(message: AppServerJsonMessage): Promise<void>;
  onMessage(handler: (message: AppServerJsonMessage) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface JsonRpcAppServerClientOptions {
  requestTimeoutMs?: number;
  idFactory?: () => AppServerRequestId;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: string;
}

export class AppServerRpcError extends Error {
  public readonly code: number;
  public readonly data: unknown;
  public readonly requestId: AppServerRequestId | null;

  constructor(
    message: string,
    options: { code: number; data?: unknown; requestId?: AppServerRequestId | null },
  ) {
    super(message);
    this.name = "AppServerRpcError";
    this.code = options.code;
    this.data = options.data;
    this.requestId = options.requestId ?? null;
  }
}

export class JsonRpcAppServerClient {
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private readonly notificationHandlers = new Set<(message: AppServerJsonMessage) => void>();
  private readonly serverRequestHandlers = new Set<(request: AppServerServerRequest) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly requestTimeoutMs: number;
  private readonly idFactory: () => AppServerRequestId;
  private closed = false;
  private nextId = 0;

  constructor(
    private readonly transport: AppServerTransport,
    options: JsonRpcAppServerClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.idFactory = options.idFactory ?? (() => ++this.nextId);
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onError((error) => this.emitError(error));
    this.transport.onClose((error) => {
      this.closed = true;
      for (const handler of this.closeHandlers) {
        handler(error);
      }
      this.rejectAllPending(error ?? new Error("Codex app-server transport closed"));
    });
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  request<M extends CodexAppServerMethod>(
    method: M,
    params: CodexAppServerMethodMap[M]["params"],
  ): Promise<CodexAppServerMethodMap[M]["result"]> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server client is closed"));
    }

    const id = this.idFactory();
    const payload: CodexAppServerRequest<M> = { id, method, params };
    const promise = new Promise<CodexAppServerMethodMap[M]["result"]>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(
              `Codex app-server request timed out after ${this.requestTimeoutMs}ms: ${method}`,
            ),
          );
        }, this.requestTimeoutMs);
        timeout.unref?.();
        this.pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
          method,
        });
      },
    );

    void this.transport.send(payload).catch((error) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });

    return promise;
  }

  onNotification(handler: (message: AppServerJsonMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: (request: AppServerServerRequest) => void): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAllPending(new Error("Codex app-server client closed"));
    await this.transport.close();
  }

  private handleMessage(message: AppServerJsonMessage): void {
    if (isResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === "string" && hasRequestId(message)) {
      for (const handler of this.serverRequestHandlers) {
        handler({
          id: message.id,
          method: message.method,
          params: message.params,
        });
      }
      return;
    }

    if (typeof message.method === "string") {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
      return;
    }

    this.emitError(new Error("Malformed Codex app-server message"));
  }

  private handleResponse(message: AppServerJsonMessage): void {
    const id = message.id as AppServerRequestId;
    const pending = this.pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(id);

    if (isJsonRpcError(message.error)) {
      pending.reject(
        new AppServerRpcError(message.error.message, {
          code: message.error.code,
          data: message.error.data,
          requestId: id,
        }),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function hasRequestId(message: AppServerJsonMessage): message is AppServerJsonMessage & {
  id: AppServerRequestId;
} {
  return typeof message.id === "string" || typeof message.id === "number";
}

function isResponse(message: AppServerJsonMessage): boolean {
  return hasRequestId(message) && ("result" in message || "error" in message);
}

function isJsonRpcError(error: unknown): error is {
  code: number;
  message: string;
  data?: JsonValue;
} {
  if (!isRecord(error)) return false;
  return typeof error.code === "number" && typeof error.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
