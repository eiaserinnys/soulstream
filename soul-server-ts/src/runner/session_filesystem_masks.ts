import { dirname, isAbsolute, join } from "node:path";

import type {
  IsolationHostPorts,
  IsolationMask,
  IsolationPreparationInput,
  MountBinding,
} from "../security/session_isolation_contract.js";
import { SessionIsolationUnavailableError } from "./session_filesystem_errors.js";

export interface IsolationMaskPlan {
  /** 디렉터리 mask를 먼저, 민감 파일 mask를 마지막에 둔다. */
  masks: IsolationMask[];
  /** mask한 부모 아래에서 RO로 다시 여는 경로. */
  rebindings: MountBinding[];
}

export interface PrepareIsolationMasksArgs {
  input: IsolationPreparationInput;
  ports: IsolationHostPorts;
  wsl: boolean;
  extraMasks: readonly IsolationMask[];
}

function byPath(left: IsolationMask, right: IsolationMask): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/**
 * §11 mask 목록. 일반 규칙은 코드에 있고, 노드별 경로는
 * `policy.filesystem.additionalSensitiveRoots`와 homeDirectory로 받는다.
 * 심볼릭 링크는 논리 경로와 실경로를 모두 열거해 alias 재노출을 막는다.
 */
export async function prepareIsolationMasks(
  args: PrepareIsolationMasksArgs,
): Promise<IsolationMaskPlan> {
  const { input, ports, wsl } = args;
  const directories = new Map<string, IsolationMask>();
  const files = new Map<string, IsolationMask>();
  const rebindings: MountBinding[] = [];

  const addEntry = (path: string, kind: IsolationMask["kind"]): void => {
    (kind === "directory" ? directories : files).set(path, { path, kind });
  };

  const addMask = async (path: string, required: boolean): Promise<void> => {
    if (!isAbsolute(path)) {
      throw new SessionIsolationUnavailableError(
        `mask 경로가 절대 경로가 아닙니다: ${path}`,
      );
    }
    const fact = await ports.lstatPath(path);
    if (!fact) {
      // 없는 대상만 required=false에서 건너뛴다. 있는 대상의 확인 실패는
      // required와 무관하게 거절한다(모르는 채로 노출하지 않는다).
      if (required) {
        throw new SessionIsolationUnavailableError(
          `필수 mask 대상을 찾을 수 없습니다: ${path}`,
        );
      }
      return;
    }

    // bwrap은 최종 구성 요소가 symlink인 destination에 mount하지 못한다.
    // symlink는 실경로만 가린다(실경로가 가려지면 alias로도 닿지 않는다).
    if (fact.kind === "symlink") {
      let real: string;
      try {
        real = await ports.resolveRealPath(path);
      } catch {
        throw new SessionIsolationUnavailableError(
          `mask symlink의 실경로를 확인할 수 없습니다: ${path}`,
        );
      }
      const realFact = await ports.lstatPath(real);
      if (!realFact) {
        throw new SessionIsolationUnavailableError(
          `mask symlink의 실경로가 없습니다: ${path}`,
        );
      }
      addEntry(real, realFact.kind === "directory" ? "directory" : "file");
      return;
    }

    addEntry(path, fact.kind === "directory" ? "directory" : "file");
    let real: string;
    try {
      real = await ports.resolveRealPath(path);
    } catch {
      throw new SessionIsolationUnavailableError(
        `mask 대상의 실경로를 확인할 수 없습니다: ${path}`,
      );
    }
    if (real === path) return;
    const realFact = await ports.lstatPath(real);
    if (!realFact) {
      throw new SessionIsolationUnavailableError(
        `mask 대상의 실경로가 없습니다: ${path}`,
      );
    }
    addEntry(real, realFact.kind === "directory" ? "directory" : "file");
  };

  const rebindReadOnly = async (
    path: string,
    requireDirectory: boolean,
  ): Promise<void> => {
    const fact = await ports.lstatPath(path);
    if (!fact || fact.kind !== "directory") {
      if (requireDirectory) {
        throw new SessionIsolationUnavailableError(
          `재노출 대상 디렉터리를 찾을 수 없습니다: ${path}`,
        );
      }
      return;
    }
    const source = await ports.resolveRealPath(path);
    rebindings.push({ source, destination: path, writable: false });
  };

  // 1. 홈의 원본 인증·에이전트 상태. canonical Codex 인증 디렉터리는 제외한다.
  for (const relative of [
    ".codex",
    ".claude",
    ".claude-accounts",
    ".gemini",
    ".pm2",
  ]) {
    await addMask(join(input.homeDirectory, relative), false);
  }
  // PM2는 socket까지 mask하고 로그만 RO로 다시 연다.
  await rebindReadOnly(join(input.homeDirectory, ".pm2/logs"), false);

  // 2. 자격 루트. backend와 무관하게 디렉터리 mask로 두고, Codex 세션만
  // canonical Codex 디렉터리를 auth binding으로 그 아래 RW 재노출한다.
  // B1은 mask → child bind → remount-ro 순서로 적용한다.
  const credentialRoot = dirname(
    join(input.homeDirectory, input.policy.filesystem.credentialRelativeDirectory),
  );
  await addMask(credentialRoot, false);

  // 3. user bus·keyring.
  await addMask(`/run/user/${input.uid}`, false);

  // 4. docker socket alias.
  await addMask("/run/docker.sock", false);
  await addMask("/var/run/docker.sock", false);

  // 5. runner state: SOUL_RUNNER_STATE_DIR 전체를 가리고 현재 세션 sandbox만
  // plan에서 RW로 다시 연다. sessionDirectory는 runnerProcessPaths의 <state>/<slug>다.
  const stateRoot = dirname(input.sessionDirectory);
  if (stateRoot === input.sessionDirectory || stateRoot === "/") {
    throw new SessionIsolationUnavailableError(
      `sessionDirectory가 runner state 하위 세션 디렉터리가 아닙니다: ${input.sessionDirectory}`,
    );
  }
  await addMask(stateRoot, true);

  // 6. 노드별 민감 루트.
  for (const root of input.policy.filesystem.additionalSensitiveRoots) {
    await addMask(root, false);
  }

  // 7. masked prod-state 아래 승인된 공통 skill/script 디렉터리만 RO 재노출.
  const agentCommonFiles = await ports.resolveAgentCommonFilesDirectory();
  if (agentCommonFiles) {
    await rebindReadOnly(agentCommonFiles, false);
  }

  // 7b. 가린 루트 아래에서 읽기만 허용할 디렉터리. 없으면 건너뛴다.
  for (const path of input.policy.filesystem.readOnlyReexposedPaths) {
    await rebindReadOnly(path, false);
  }

  // 8. WSL은 /mnt와 /run/WSL이 필수다. 없으면 restricted를 시작하지 않는다.
  if (wsl) {
    await addMask("/mnt", true);
    await addMask("/run/WSL", true);
  }

  // 9. 서비스 env 파일. dotenv가 읽는 디렉터리의 최상위에서 `.env`로 시작하는
  // file/symlink만 가린다. 수동 편집이 만드는 `.before-*` 백업도 함께 걸리고,
  // 하위 디렉터리로는 내려가지 않는다. symlink는 실경로를 가린다.
  const serviceEnvironmentDirectory = await ports.resolveServiceEnvironmentDirectory();
  if (serviceEnvironmentDirectory) {
    const entries = await ports.listDirectory(serviceEnvironmentDirectory);
    for (const entry of entries) {
      if (!entry.name.startsWith(".env")) continue;
      if (entry.kind !== "file" && entry.kind !== "symlink") continue;
      await addMask(join(serviceEnvironmentDirectory, entry.name), false);
    }
  }

  for (const mask of args.extraMasks) {
    if (mask.kind === "directory") directories.set(mask.path, mask);
    else files.set(mask.path, mask);
  }

  return {
    masks: [...directories.values()].sort(byPath).concat([...files.values()].sort(byPath)),
    rebindings,
  };
}
