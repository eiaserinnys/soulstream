import { join } from "node:path";

// soul-server-ts/src/runner/runner_process_paths.ts와 같은 값이어야 한다.
export const LINUX_UNIX_SOCKET_PATH_MAX_BYTES = 107;
export const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES = 103;
export const RUNNER_SESSION_SLUG_LENGTH = 24;
export const RUNNER_SOCKET_FILE_NAME = "runner.sock";

/** state 디렉터리 아래에서 가장 긴 러너 소켓 경로의 바이트 수. */
export function runnerSocketPathByteLength(stateDirectory) {
  return Buffer.byteLength(
    join(stateDirectory, "0".repeat(RUNNER_SESSION_SLUG_LENGTH), RUNNER_SOCKET_FILE_NAME),
    "utf8",
  );
}

export function assertRunnerStatePathCompatible(stateDirectory, platform = process.platform) {
  if (platform === "win32") return;
  const maximumBytes =
    platform === "darwin" ? DARWIN_UNIX_SOCKET_PATH_MAX_BYTES : LINUX_UNIX_SOCKET_PATH_MAX_BYTES;
  const socketPathBytes = runnerSocketPathByteLength(stateDirectory);
  if (socketPathBytes > maximumBytes) {
    throw new Error(
      `SOUL_RUNNER_STATE_DIR가 만드는 러너 소켓 경로가 ${socketPathBytes}바이트로 한계(${maximumBytes}바이트)를 넘습니다. 저장소를 더 짧은 경로에 clone한 뒤 다시 실행하십시오.`,
    );
  }
}
