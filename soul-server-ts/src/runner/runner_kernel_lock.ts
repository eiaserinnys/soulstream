import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { resolve, win32 } from "node:path";

import {
  isDarwinKernelLockHeld,
  tryAcquireDarwinKernelLock,
} from "./runner_darwin_kernel_lock.js";

const LOCK_NAME_PREFIX = "soulstream-runner-lock-";

/**
 * A process-lifetime lock backed by a kernel-owned exclusive resource.
 *
 * Linux abstract Unix sockets, Windows named pipes, and Darwin SQLite
 * EXCLUSIVE transactions share the two properties the former owner file did
 * not: acquisition is exclusive, and the OS releases ownership when the
 * process dies. The filesystem path is only the stable input to the lock name;
 * no lease, pid probe, or timeout participates in the ownership decision.
 */
export class RunnerKernelLock {
  private released = false;

  private constructor(private readonly releaseKernelLock: () => Promise<void>) {}

  static async tryAcquire(path: string): Promise<RunnerKernelLock | null> {
    if (process.platform === "darwin") {
      const lock = tryAcquireDarwinKernelLock(path);
      return lock === null
        ? null
        : new RunnerKernelLock(async () => { lock.release(); });
    }
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
    return new RunnerKernelLock(async () => {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
      });
    });
  }

  static async isHeld(path: string): Promise<boolean> {
    if (process.platform === "darwin") return isDarwinKernelLockHeld(path);
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
    await this.releaseKernelLock();
  }
}

export function runnerKernelLockEndpoint(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const canonicalPath = platform === "win32"
    ? win32.resolve(path).toLowerCase()
    : resolve(path);
  const digest = createHash("sha256").update(canonicalPath).digest("hex");
  if (platform === "linux") return `\0${LOCK_NAME_PREFIX}${digest}`;
  if (platform === "win32") return `\\\\.\\pipe\\${LOCK_NAME_PREFIX}${digest}`;
  throw new Error(`runner kernel lock is unsupported on ${platform}`);
}
