import {
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export const RUNNER_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const RUNNER_LOG_BACKUP_COUNT = 2;
export const RUNNER_LOG_ROTATION_INTERVAL_MS = 1_000;

export function rotateRunnerLogIfNeeded(
  fd: number,
  path: string,
  maxBytes = RUNNER_LOG_MAX_BYTES,
  backupCount = RUNNER_LOG_BACKUP_COUNT,
): boolean {
  if (maxBytes <= 0 || backupCount <= 0) {
    throw new Error("runner log rotation limits must be positive");
  }
  const size = fstatSync(fd).size;
  if (size <= maxBytes) return false;
  for (let index = backupCount; index >= 1; index -= 1) {
    const target = `${path}.${index}`;
    if (index === backupCount) rmSync(target, { force: true });
    if (index > 1) {
      try {
        renameSync(`${path}.${index - 1}`, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const retainedBytes = Math.min(size, maxBytes);
  const retained = Buffer.allocUnsafe(retainedBytes);
  const readFd = openSync(path, "r");
  try {
    readSync(readFd, retained, 0, retainedBytes, size - retainedBytes);
  } finally {
    closeSync(readFd);
  }
  writeFileSync(`${path}.1`, retained, { mode: 0o600 });
  ftruncateSync(fd, 0);
  return true;
}

export function startRunnerLogRotation(
  fd: number,
  path: string,
  onError: (error: unknown) => void,
): () => void {
  const timer = setInterval(() => {
    try {
      rotateRunnerLogIfNeeded(fd, path);
    } catch (error) {
      onError(error);
    }
  }, RUNNER_LOG_ROTATION_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
