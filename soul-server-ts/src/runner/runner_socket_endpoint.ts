import { createServer, connect, type Server, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";

import { RunnerIpcConnection } from "./runner_ipc_connection.js";
import type { RunnerDroppedFrame } from "./runner_frame_drop.js";

export interface ConnectRunnerSocketOptions {
  timeoutMs: number;
  /** Absolute wall-clock budget across connect attempts and retry delays. */
  deadlineMs?: number;
  retryDelayMs?: number;
  onFrameDropped?(drop: RunnerDroppedFrame): void;
}

export const RUNNER_SOCKET_RETRYABLE_ERROR_CODES = [
  "EAGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "ETIMEDOUT",
] as const;

const RETRYABLE_ERROR_CODES = new Set<string>(RUNNER_SOCKET_RETRYABLE_ERROR_CODES);

/** Runner-owned listener. A reconnect replaces only the transport, not the process. */
export class RunnerSocketEndpoint {
  private server: Server | undefined;
  private connection: RunnerIpcConnection | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly handleFrame: (frame: import("./frame_protocol.js").RunnerFrame) => Promise<void>,
    private readonly handleFailure: (error: Error) => void,
    private readonly handleDroppedFrame: (drop: RunnerDroppedFrame) => void = () => {},
  ) {}

  get currentConnection(): RunnerIpcConnection | undefined {
    return this.connection;
  }

  async listen(): Promise<void> {
    if (this.server) throw new Error("Runner socket endpoint already listening");
    if (process.platform !== "win32") await unlinkIfPresent(this.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    this.connection?.close();
    this.connection = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== "win32") await unlinkIfPresent(this.socketPath);
  }

  private accept(socket: Socket): void {
    this.connection?.close();
    const connection = new RunnerIpcConnection(socket, {
      onFrameDropped: this.handleDroppedFrame,
    });
    this.connection = connection;
    connection.onFrame(this.handleFrame);
    connection.onFailure((error) => {
      if (this.connection === connection) this.connection = undefined;
      this.handleFailure(error);
    });
  }
}

export async function connectRunnerSocket(
  socketPath: string,
  options: ConnectRunnerSocketOptions,
): Promise<RunnerIpcConnection> {
  const deadlineMs = options.deadlineMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 50;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error("Runner socket connect deadline must be positive");
  }
  const deadlineAt = Date.now() + deadlineMs;
  let lastError: Error | undefined;
  for (;;) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    try {
      return new RunnerIpcConnection(
        await connectOnce(socketPath, Math.min(options.timeoutMs, remainingMs)),
        { onFrameDropped: options.onFrameDropped },
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableSocketError(error)) throw lastError;
      const retryBudgetMs = deadlineAt - Date.now();
      if (retryBudgetMs <= 0) break;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(retryDelayMs, retryBudgetMs),
      ));
    }
  }
  throw new Error(`Runner socket unavailable after ${deadlineMs}ms deadline`, {
    cause: lastError,
  });
}

async function connectOnce(path: string, timeoutMs: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(
        new Error(`Runner socket connect timed out after ${timeoutMs}ms`),
        { code: "ETIMEDOUT" },
      ));
    }, timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isRetryableSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && RETRYABLE_ERROR_CODES.has(code);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
