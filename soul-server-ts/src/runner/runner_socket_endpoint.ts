import { createServer, connect, type Server, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";

import { RunnerIpcConnection } from "./runner_ipc_connection.js";

export interface ConnectRunnerSocketOptions {
  timeoutMs: number;
  attempts?: number;
  retryDelayMs?: number;
}

/** Runner-owned listener. A reconnect replaces only the transport, not the process. */
export class RunnerSocketEndpoint {
  private server: Server | undefined;
  private connection: RunnerIpcConnection | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly handleFrame: (frame: import("./frame_protocol.js").RunnerFrame) => Promise<void>,
    private readonly handleFailure: (error: Error) => void,
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
    const connection = new RunnerIpcConnection(socket);
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
  const attempts = options.attempts ?? 20;
  const retryDelayMs = options.retryDelayMs ?? 50;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return new RunnerIpcConnection(await connectOnce(socketPath, options.timeoutMs));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw new Error(`Runner socket unavailable after ${attempts} attempts`, { cause: lastError });
}

async function connectOnce(path: string, timeoutMs: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Runner socket connect timed out after ${timeoutMs}ms`));
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

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
