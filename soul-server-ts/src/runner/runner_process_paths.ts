import { createHash } from "node:crypto";
import { join } from "node:path";

export interface RunnerProcessPaths {
  sessionDirectory: string;
  databasePath: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  configPath: string;
}

export function runnerProcessPaths(
  stateDirectory: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): RunnerProcessPaths {
  if (!stateDirectory) throw new Error("runner state directory required");
  if (!sessionId) throw new Error("runner session id required");
  const slug = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const sessionDirectory = join(stateDirectory, slug);
  return {
    sessionDirectory,
    databasePath: join(sessionDirectory, "runner.sqlite"),
    socketPath: platform === "win32"
      ? `\\\\.\\pipe\\soulstream-runner-${slug}`
      : join(sessionDirectory, "runner.sock"),
    pidPath: join(sessionDirectory, "runner.pid"),
    lockPath: join(sessionDirectory, "runner.lock"),
    configPath: join(sessionDirectory, "runner-config.json"),
  };
}
