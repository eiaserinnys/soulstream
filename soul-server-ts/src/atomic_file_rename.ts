import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const TRANSIENT_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const;

export interface AsyncRenameRetryOptions {
  renameFile?: (sourcePath: string, destinationPath: string) => Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export interface SyncRenameRetryOptions {
  renameFile?: (sourcePath: string, destinationPath: string) => void;
  sleep?: (delayMs: number) => void;
  retryDelaysMs?: readonly number[];
}

export async function renameWithTransientRetry(
  sourcePath: string,
  destinationPath: string,
  options: AsyncRenameRetryOptions = {},
): Promise<void> {
  const renameFile = options.renameFile ?? rename;
  const sleep = options.sleep ?? delay;
  const retryDelaysMs = options.retryDelaysMs ?? TRANSIENT_RENAME_RETRY_DELAYS_MS;
  let retryIndex = 0;
  while (true) {
    try {
      await renameFile(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (
        !isTransientRenameError(error)
        || retryIndex >= retryDelaysMs.length
      ) {
        throw error;
      }
      await sleep(retryDelaysMs[retryIndex]!);
      retryIndex += 1;
    }
  }
}

export function renameWithTransientRetrySync(
  sourcePath: string,
  destinationPath: string,
  options: SyncRenameRetryOptions = {},
): void {
  const renameFile = options.renameFile ?? renameSync;
  const sleep = options.sleep ?? sleepSync;
  const retryDelaysMs = options.retryDelaysMs ?? TRANSIENT_RENAME_RETRY_DELAYS_MS;
  let retryIndex = 0;
  while (true) {
    try {
      renameFile(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (
        !isTransientRenameError(error)
        || retryIndex >= retryDelaysMs.length
      ) {
        throw error;
      }
      sleep(retryDelaysMs[retryIndex]!);
      retryIndex += 1;
    }
  }
}

export function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepSync(delayMs: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, delayMs);
}
