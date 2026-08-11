import { createHash } from "node:crypto";
import { join } from "node:path";

export interface RunnerProcessPaths {
  sessionDirectory: string;
  databasePath: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  configPath: string;
  logPath: string;
}

export const LINUX_UNIX_SOCKET_PATH_MAX_BYTES = 107;
const RUNNER_SESSION_SLUG_LENGTH = 24;
const RUNNER_SOCKET_FILE_NAME = "runner.sock";

export function runnerSocketPathByteLength(stateDirectory: string): number {
  const longestSocketPath = join(
    stateDirectory,
    "0".repeat(RUNNER_SESSION_SLUG_LENGTH),
    RUNNER_SOCKET_FILE_NAME,
  );
  return Buffer.byteLength(longestSocketPath, "utf8");
}

export function assertRunnerStateDirectoryCompatible(
  stateDirectory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") return;
  const socketPathBytes = runnerSocketPathByteLength(stateDirectory);
  if (socketPathBytes > LINUX_UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `SOUL_RUNNER_STATE_DIR produces a ${socketPathBytes} byte runner socket path; `
      + `maximum is ${LINUX_UNIX_SOCKET_PATH_MAX_BYTES} bytes`,
    );
  }
}

export function runnerProcessPaths(
  stateDirectory: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): RunnerProcessPaths {
  if (!stateDirectory) throw new Error("runner state directory required");
  if (!sessionId) throw new Error("runner session id required");
  assertRunnerStateDirectoryCompatible(stateDirectory, platform);
  const slug = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, RUNNER_SESSION_SLUG_LENGTH);
  const sessionDirectory = join(stateDirectory, slug);
  return {
    sessionDirectory,
    databasePath: join(sessionDirectory, "runner.sqlite"),
    socketPath: platform === "win32"
      ? `\\\\.\\pipe\\soulstream-runner-${slug}`
      : join(sessionDirectory, RUNNER_SOCKET_FILE_NAME),
    pidPath: join(sessionDirectory, "runner.pid"),
    lockPath: join(sessionDirectory, "runner.lock"),
    configPath: join(sessionDirectory, "runner-config.json"),
    logPath: join(sessionDirectory, "runner.log"),
  };
}
