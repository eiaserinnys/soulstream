import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Transport backing `socketPath`. A unix socket is a filesystem entry the
 * host can quarantine and unlink; a Windows named pipe lives in the pipe
 * namespace, has no filesystem entity, and is reclaimed by the OS when its
 * owning process exits. Callers that mutate filesystem evidence must branch
 * on this kind instead of sniffing the path string.
 */
export type RunnerSocketKind = "unix_socket" | "named_pipe";

export interface RunnerProcessPaths {
  sessionDirectory: string;
  databasePath: string;
  socketPath: string;
  socketKind: RunnerSocketKind;
  pidPath: string;
  lockPath: string;
  configPath: string;
  logPath: string;
}

/**
 * The spawn contract is `node <snapshot>/runner_entry.js --config <configPath>`
 * (`runner_process_spawn.ts`). Both halves are required as proof: the entry
 * module says "a Soulstream runner", the config path says "of this session".
 * Either half alone would convict a sibling session's runner.
 */
export const RUNNER_ENTRY_MODULE = "runner_entry.js";

export function commandLineOwnedBySession(
  commandLine: string,
  paths: RunnerProcessPaths,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const reported = normalizeCommandLinePath(commandLine, platform);
  return reported.includes(normalizeCommandLinePath(RUNNER_ENTRY_MODULE, platform))
    && reported.includes(normalizeCommandLinePath(paths.configPath, platform));
}

/**
 * The OS reports the command line as it was quoted, not as `join` produced it,
 * so separators and (on Windows) case are not stable across the comparison.
 */
function normalizeCommandLinePath(value: string, platform: NodeJS.Platform): string {
  const separatorNormalized = value.replaceAll("\\", "/");
  return platform === "win32" ? separatorNormalized.toLowerCase() : separatorNormalized;
}

export const LINUX_UNIX_SOCKET_PATH_MAX_BYTES = 107;
const RUNNER_SESSION_SLUG_LENGTH = 24;
const RUNNER_SOCKET_FILE_NAME = "runner.sock";
const RUNNER_STATE_INFRASTRUCTURE_PREFIX = "_";

/**
 * Runner paths use hexadecimal hashes, while underscore-prefixed direct
 * children are reserved for node-level infrastructure such as `_control`.
 * Every other directory remains a registration candidate so damaged or
 * legacy evidence is still surfaced through the fail-closed scan contract.
 */
export function isRunnerRegistrationDirectoryName(name: string): boolean {
  return !name.startsWith(RUNNER_STATE_INFRASTRUCTURE_PREFIX);
}

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
    socketKind: platform === "win32" ? "named_pipe" : "unix_socket",
    pidPath: join(sessionDirectory, "runner.pid"),
    lockPath: join(sessionDirectory, "runner.lock"),
    configPath: join(sessionDirectory, "runner-config.json"),
    logPath: join(sessionDirectory, "runner.log"),
  };
}
