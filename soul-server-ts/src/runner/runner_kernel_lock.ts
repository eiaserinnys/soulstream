import { createHash } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { resolve } from "node:path";

const LOCK_NAME_PREFIX = "soulstream-runner-lock-";

/**
 * A process-lifetime lock backed by a kernel-owned listening endpoint.
 *
 * Linux abstract Unix sockets and Windows named pipes have the two properties
 * the former owner file did not: bind is exclusive, and the OS releases the
 * endpoint when the process dies. The filesystem path is only the stable input
 * to the endpoint name; no lease, pid probe, or timeout participates in the
 * ownership decision.
 */
export class RunnerKernelLock {
  private released = false;

  private constructor(private readonly server: Server) {}

  static async tryAcquire(path: string): Promise<RunnerKernelLock | null> {
    const server = createServer((socket) => socket.destroy());
    const acquired = await new Promise<boolean>((resolveAcquire, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE") {
          resolveAcquire(false);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveAcquire(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(runnerKernelLockEndpoint(path));
    });
    if (!acquired) return null;
    return new RunnerKernelLock(server);
  }

  static async isHeld(path: string): Promise<boolean> {
    return await new Promise<boolean>((resolveHeld, reject) => {
      const socket = createConnection(runnerKernelLockEndpoint(path));
      socket.once("connect", () => {
        socket.destroy();
        resolveHeld(true);
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          resolveHeld(false);
          return;
        }
        reject(error);
      });
    });
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await new Promise<void>((resolveClose, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolveClose();
      });
    });
  }
}

export function runnerKernelLockEndpoint(path: string): string {
  const canonicalPath = process.platform === "win32"
    ? resolve(path).toLowerCase()
    : resolve(path);
  const digest = createHash("sha256").update(canonicalPath).digest("hex");
  if (process.platform === "linux") return `\0${LOCK_NAME_PREFIX}${digest}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${LOCK_NAME_PREFIX}${digest}`;
  throw new Error(`runner kernel lock is unsupported on ${process.platform}`);
}
