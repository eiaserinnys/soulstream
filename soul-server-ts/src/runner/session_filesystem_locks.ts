import type {
  IsolationHostPorts,
  MountBinding,
} from "../security/session_isolation_contract.js";
import { SessionIsolationUnavailableError } from "./session_filesystem_errors.js";

/**
 * heavy_verify.py의 host-wide gate와 slot 파일. sandbox에서도 같은 절대 경로로
 * 보이도록 host 원본을 RW file bind 한다.
 */
export const HEAVY_WORK_LOCK_PATHS = [
  "/tmp/soulstream-heavy-verify.lock",
  "/tmp/soulstream-heavy-verify.slot-1.lock",
  "/tmp/soulstream-heavy-verify.slot-2.lock",
  "/tmp/soulstream-heavy-verify.slot-3.lock",
] as const;

export const HOST_PROC_LOCKS_PATH = "/proc/locks";

export interface PreparedHeavyWorkLocks {
  heavyWorkLockBindings: MountBinding[];
  hostProcLocksBinding: MountBinding;
}

/**
 * 기존 _open_lock 계약(mode 0600, 일반 파일, 동일 inode)에 맞춰 lock 파일을
 * 확인하고, host /proc/locks를 RO로 한 파일만 공급한다. 기존 파일을 자르거나
 * 교체하지 않는다.
 */
export async function prepareHeavyWorkLocks(
  ports: IsolationHostPorts,
): Promise<PreparedHeavyWorkLocks> {
  const heavyWorkLockBindings: MountBinding[] = [];
  for (const path of HEAVY_WORK_LOCK_PATHS) {
    await ports.ensureLockFile(path, 0o600);
    const fact = await ports.lstatPath(path);
    if (!fact || fact.kind !== "file") {
      throw new SessionIsolationUnavailableError(
        `heavy-work lock이 일반 파일이 아닙니다: ${path}`,
      );
    }
    const source = await ports.resolveRealPath(path);
    heavyWorkLockBindings.push({ source, destination: path, writable: true });
  }

  const procLocksFact = await ports.lstatPath(HOST_PROC_LOCKS_PATH);
  if (!procLocksFact || procLocksFact.kind !== "file") {
    throw new SessionIsolationUnavailableError(
      "host /proc/locks를 파일로 읽을 수 없습니다",
    );
  }
  const procLocksSource = await ports.resolveRealPath(HOST_PROC_LOCKS_PATH);

  return {
    heavyWorkLockBindings,
    hostProcLocksBinding: {
      source: procLocksSource,
      destination: HOST_PROC_LOCKS_PATH,
      writable: false,
    },
  };
}
