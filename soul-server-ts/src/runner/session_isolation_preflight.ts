import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { IsolationLaunchInput } from "../security/session_isolation_contract.js";

/** 격리를 시작할 수 없을 때의 단일 실패 코드. */
export const SESSION_ISOLATION_UNAVAILABLE = "SESSION_ISOLATION_UNAVAILABLE" as const;

export class SessionIsolationUnavailableError extends Error {
  readonly code = SESSION_ISOLATION_UNAVAILABLE;

  constructor(
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${SESSION_ISOLATION_UNAVAILABLE}: ${detail}`, options);
    this.name = "SessionIsolationUnavailableError";
  }
}

export interface IsolationToolchainProbe {
  /** 절대 경로가 실행 가능한 일반 파일이면 true. */
  isExecutableFile(path: string): boolean;
  /** 텍스트를 읽는다. 없거나 읽을 수 없으면 null. */
  readTextFile(path: string): string | null;
}

export const defaultIsolationToolchainProbe: IsolationToolchainProbe = {
  isExecutableFile(path: string): boolean {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readTextFile(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

const USER_NAMESPACES_LIMIT_PATH = "/proc/sys/user/max_user_namespaces";
const UNPRIVILEGED_USERNS_CLONE_PATH = "/proc/sys/kernel/unprivileged_userns_clone";

/**
 * 상자를 띄우기 전에 필요한 것이 전부 있는지 확인한다. 하나라도 빠지면
 * SESSION_ISOLATION_UNAVAILABLE로 fail-closed하며, 네트워크 없이 그냥
 * 실행하는 대체 경로는 두지 않는다.
 *
 * 여기서는 부작용이 없다. 프로세스를 띄우지 않고 시그널도 보내지 않는다.
 */
export function assertIsolationToolchainReady(
  input: IsolationLaunchInput,
  probe: IsolationToolchainProbe = defaultIsolationToolchainProbe,
): void {
  const failures: string[] = [];

  const tools: ReadonlyArray<readonly [string, string]> = [
    ["bwrap", input.tools.bwrap],
    ["pasta", input.tools.pasta],
    ["unshare", input.tools.unshare],
    ["setpriv", input.tools.setpriv],
    ["nft", input.tools.nft],
    ["netns helper", input.tools.netnsHelper],
  ];
  for (const [label, toolPath] of tools) {
    if (!isAbsolute(toolPath)) {
      failures.push(`${label} path is not absolute: ${toolPath}`);
      continue;
    }
    if (!probe.isExecutableFile(toolPath)) {
      failures.push(`${label} is missing or not executable: ${toolPath}`);
    }
  }

  if (!isAbsolute(input.plan.workspaceDir)) {
    failures.push(`workspace directory is not absolute: ${input.plan.workspaceDir}`);
  }
  if (!isAbsolute(input.cwd)) {
    failures.push(`launch cwd is not absolute: ${input.cwd}`);
  }
  if (!isAbsolute(input.resolvConfPath)) {
    failures.push(`sandbox resolv.conf path is not absolute: ${input.resolvConfPath}`);
  } else if (probe.readTextFile(input.resolvConfPath) === null) {
    failures.push(`sandbox resolv.conf is missing: ${input.resolvConfPath}`);
  }

  const userNamespaceLimit = probe.readTextFile(USER_NAMESPACES_LIMIT_PATH);
  if (userNamespaceLimit === null) {
    failures.push(`user namespaces are unavailable: ${USER_NAMESPACES_LIMIT_PATH} is missing`);
  } else if (!(Number.parseInt(userNamespaceLimit.trim(), 10) > 0)) {
    failures.push(`user namespaces are disabled: ${USER_NAMESPACES_LIMIT_PATH} is 0`);
  }

  const unprivilegedClone = probe.readTextFile(UNPRIVILEGED_USERNS_CLONE_PATH);
  if (unprivilegedClone !== null && unprivilegedClone.trim() !== "1") {
    failures.push(
      `unprivileged user namespaces are disabled: ${UNPRIVILEGED_USERNS_CLONE_PATH} is ${unprivilegedClone.trim()}`,
    );
  }

  if (failures.length > 0) {
    throw new SessionIsolationUnavailableError(failures.join("; "));
  }
}
