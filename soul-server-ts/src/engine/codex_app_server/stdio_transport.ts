import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import type { AppServerTransportUrl } from "./protocol.js";
import type { AppServerJsonMessage, AppServerTransport } from "./transport.js";

export interface AppServerTransportLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

type AppServerChildProcess = Pick<
  ChildProcessWithoutNullStreams,
  "stdin" | "stdout" | "stderr" | "pid" | "kill" | "on"
>;

export type StdioSpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => AppServerChildProcess;

export interface StdioAppServerTransportOptions {
  command?: string;
  listenUrl?: AppServerTransportUrl;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: AppServerTransportLogger;
  closeGraceMs?: number;
  spawnProcess?: StdioSpawnProcess;
}

const NOOP_LOGGER: AppServerTransportLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function buildCodexAppServerArgs(
  listenUrl: AppServerTransportUrl = "stdio://",
): string[] {
  return ["app-server", "--listen", listenUrl];
}

export function createStdioAppServerTransport(
  options: StdioAppServerTransportOptions = {},
): AppServerTransport {
  return new StdioAppServerTransport(options);
}

class StdioAppServerTransport implements AppServerTransport {
  private readonly child: AppServerChildProcess;
  private readonly logger: AppServerTransportLogger;
  private readonly closeGraceMs: number;
  private readonly messageHandlers = new Set<(message: AppServerJsonMessage) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private resolveClose: (() => void) | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: StdioAppServerTransportOptions) {
    const command = options.command ?? "codex";
    const listenUrl = options.listenUrl ?? "stdio://";
    const args = buildCodexAppServerArgs(listenUrl);
    this.logger = options.logger ?? NOOP_LOGGER;
    this.closeGraceMs = options.closeGraceMs ?? 2_000;
    const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });

    this.logger.debug({ pid: this.child.pid, command, args }, "Codex app-server spawned");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.handleStderr(chunk));
    this.child.on("error", (error) => {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on("exit", (code, signal) => {
      this.finishClose(exitError(code, signal));
    });
  }

  async send(message: AppServerJsonMessage): Promise<void> {
    if (this.closed) {
      throw new Error("Codex app-server transport is closed");
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  onMessage(handler: (message: AppServerJsonMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    this.child.kill("SIGTERM");
    this.closeTimer = setTimeout(() => {
      if (!this.closed) {
        this.child.kill("SIGKILL");
        this.finishClose(new Error("Codex app-server close timed out"));
      }
    }, this.closeGraceMs);
    this.closeTimer.unref?.();
    return this.closePromise;
  }

  private handleStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += chunk.toString();
    this.drainLines("stdout");
  }

  private handleStderr(chunk: Buffer | string): void {
    this.stderrBuffer += chunk.toString();
    this.drainLines("stderr");
  }

  private drainLines(stream: "stdout" | "stderr"): void {
    const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
    let buffer = this[key];
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (stream === "stdout") {
        this.handleStdoutLine(line);
      } else {
        this.handleStderrLine(line);
      }
    }
    this[key] = buffer;
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.emitError(
        new Error(
          `Malformed Codex app-server JSON: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (!isRecord(parsed)) {
      this.emitError(new Error("Malformed Codex app-server JSON: expected object"));
      return;
    }
    for (const handler of this.messageHandlers) {
      handler(parsed);
    }
  }

  private handleStderrLine(line: string): void {
    if (!line.trim()) return;
    this.logger.warn({ line }, "Codex app-server stderr");
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private finishClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    for (const handler of this.closeHandlers) {
      handler(error);
    }
    this.resolveClose?.();
    this.resolveClose = null;
  }
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): AppServerChildProcess {
  return spawn(command, args, options);
}

function exitError(code: number | null, signal: NodeJS.Signals | null): Error | undefined {
  if (code === 0) return undefined;
  if (code !== null) return new Error(`Codex app-server exited with code ${code}`);
  if (signal) return new Error(`Codex app-server exited with signal ${signal}`);
  return new Error("Codex app-server exited");
}

function isRecord(value: unknown): value is AppServerJsonMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
