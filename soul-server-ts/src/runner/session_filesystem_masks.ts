import { dirname, isAbsolute, join } from "node:path";

import type {
  IsolationHostPorts,
  IsolationMask,
  IsolationPreparationInput,
  MountBinding,
} from "../security/session_isolation_contract.js";
import { SessionIsolationUnavailableError } from "./session_filesystem_errors.js";

export interface IsolationEnvMaskScan {
  /** 실제로 훑은 뿌리 수(중복·하위 뿌리 정리 뒤). */
  roots: number;
  /** 이름을 확인한 파일·심볼릭 링크 수. */
  files: number;
  /** 새로 계획에 넣은 가림 수(이미 있던 경로와 중복은 세지 않는다). */
  masked: number;
  elapsedMs: number;
}

export interface IsolationMaskPlan {
  /** 디렉터리 mask를 먼저, 민감 파일 mask를 마지막에 둔다. */
  masks: IsolationMask[];
  /** mask한 부모 아래에서 RO로 다시 여는 경로. */
  rebindings: MountBinding[];
  /** 재귀 `.env` 탐색 통계. 로그로만 쓴다. */
  envScan: IsolationEnvMaskScan;
}

export interface PrepareIsolationMasksArgs {
  input: IsolationPreparationInput;
  ports: IsolationHostPorts;
  wsl: boolean;
  extraMasks: readonly IsolationMask[];
}

/** 재귀 탐색에서 내려가지 않는 디렉터리 이름. */
const ENV_MASK_SCAN_SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "target",
  ".next",
]);

/** 뿌리(깊이 0)에서 내려가는 최대 깊이. 그보다 깊은 항목은 보지 않는다. */
const ENV_MASK_SCAN_MAX_DEPTH = 8;

/** 예시·틀 파일은 가리지 않는다. */
const ENV_MASK_SCAN_EXCLUDED_SUFFIXES = [".example", ".sample", ".template"] as const;

/**
 * `.env`, `.env.<무엇>`, `<무엇>.env` 이름이면 가림 대상이다.
 * `.env.example`처럼 예시·틀 접미사로 끝나는 이름은 뺀다.
 */
export function isEnvMaskTargetName(name: string): boolean {
  const candidate = name === ".env"
    || name.startsWith(".env.")
    || name.endsWith(".env");
  if (!candidate) return false;
  return !ENV_MASK_SCAN_EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** `path`가 `root`와 같거나 그 아래인지 구성 요소 경계로 판정한다. */
function isPathAtOrUnder(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

function byPath(left: IsolationMask, right: IsolationMask): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/** 같은 경로를 겹쳐 훑지 않도록 상위 뿌리만 남긴다. */
function dedupeRoots(roots: Iterable<string>): string[] {
  const sorted = [...new Set(roots)].sort((left, right) =>
    left.length - right.length || (left < right ? -1 : left > right ? 1 : 0),
  );
  const kept: string[] = [];
  for (const root of sorted) {
    if (kept.some((candidate) => isPathAtOrUnder(root, candidate))) continue;
    kept.push(root);
  }
  return kept;
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
  ): Promise<string | null> => {
    const fact = await ports.lstatPath(path);
    if (!fact || fact.kind !== "directory") {
      if (requireDirectory) {
        throw new SessionIsolationUnavailableError(
          `재노출 대상 디렉터리를 찾을 수 없습니다: ${path}`,
        );
      }
      return null;
    }
    const source = await ports.resolveRealPath(path);
    rebindings.push({ source, destination: path, writable: false });
    return source;
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

  // 2b. 계정 풀 자격 루트. restricted Claude OAuth만 실제 설정 경로를 가린다.
  // 프로필 원본(.credentials.json·refreshToken)은 상자 안에서 읽을 수 없다.
  if (
    input.authPreparation.kind === "claude-oauth-token"
    && input.claudeAccountsDir
  ) {
    await addMask(input.claudeAccountsDir, true);
  }

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

  // 6b. 노드 incoming 루트. 정책 mask가 덮지 않는 배치에서도 다른 세션의 첨부가
  // 보이지 않게 늘 가리고, 이 세션 폴더만 plan이 RO로 다시 연다.
  await addMask(input.incomingRoot, false);

  // 재귀 `.env` 탐색에 쓸 RO 재노출 뿌리. mask 아래에서 다시 여는 경로는
  // 그 아래 `.env`도 다시 보이므로 함께 훑는다.
  const readOnlyRoots: string[] = [];

  // 7. masked prod-state 아래 승인된 공통 skill/script 디렉터리만 RO 재노출.
  const agentCommonFiles = await ports.resolveAgentCommonFilesDirectory();
  if (agentCommonFiles) {
    const real = await rebindReadOnly(agentCommonFiles, false);
    if (real) readOnlyRoots.push(real);
  }

  // 7b. 가린 루트 아래에서 읽기만 허용할 디렉터리. 없으면 건너뛴다.
  for (const path of input.policy.filesystem.readOnlyReexposedPaths) {
    const real = await rebindReadOnly(path, false);
    if (real) readOnlyRoots.push(real);
  }

  // 8. WSL은 /mnt와 /run/WSL이 필수다. 없으면 restricted를 시작하지 않는다.
  if (wsl) {
    await addMask("/mnt", true);
    await addMask("/run/WSL", true);
  }

  // 9. `.env` 재귀 가림. 상자에 RO로 다시 여는 경로(호스트 워크스페이스 루트,
  // readOnlyReexposedPaths, 공통 파일 디렉터리, 서비스 env 디렉터리) 아래를
  // 훑는다. 세션이 쓸 수 있게 연 경로 아래는 자기 작업물이므로 뺀다.
  const directoryReal = async (path: string): Promise<string | null> => {
    try {
      const fact = await ports.lstatPath(path);
      if (!fact || fact.kind !== "directory") return null;
      return await ports.resolveRealPath(path);
    } catch {
      return null;
    }
  };

  const hostWorkspaceReal = await directoryReal(input.hostWorkspaceRoot);
  const hostRoot = hostWorkspaceReal ?? input.hostWorkspaceRoot;

  const scanRoots: string[] = [];
  const addScanRoot = (path: string | null | undefined): void => {
    if (path) scanRoots.push(path);
  };
  for (const root of readOnlyRoots) addScanRoot(root);
  addScanRoot(hostWorkspaceReal);
  const serviceEnvironmentDirectory = await ports.resolveServiceEnvironmentDirectory();
  const serviceEnvironmentReal = serviceEnvironmentDirectory
    ? await directoryReal(serviceEnvironmentDirectory)
    : null;
  addScanRoot(serviceEnvironmentReal);

  const exclusions = new Set<string>();
  const addExclusion = async (path: string): Promise<void> => {
    exclusions.add(path);
    try {
      exclusions.add(await ports.resolveRealPath(path));
    } catch {
      // 아직 없는 쓰기 경로(예: 이번 턴에 만들 .local/tmp)는 원래 경로로 충분하다.
    }
  };
  await addExclusion(join(hostRoot, ".local/tmp"));
  await addExclusion(join(hostRoot, ".local/artifacts"));
  await addExclusion(
    join(
      hostRoot,
      input.policy.filesystem.sessionWorktreeRelativeRoot,
      input.decision.sessionId,
    ),
  );
  await addExclusion(join(input.sessionDirectory, "sandbox"));
  // scratch가 호스트 워크스페이스 루트 자체면 그 루트는 RO bind라 탐색 뿌리로
  // 남긴다. 그 아래 워크트리는 이미 별도로 뺀다.
  if (!isPathAtOrUnder(hostRoot, input.scratchWorkspaceDir)) {
    await addExclusion(input.scratchWorkspaceDir);
  }
  await addExclusion(
    join(input.homeDirectory, input.policy.filesystem.isolatedCacheRelativeRoot),
  );
  for (const attachment of [
    ...input.ownedWorktrees,
    ...input.attachedWorktrees,
  ]) {
    await addExclusion(attachment.canonicalPath);
  }

  const scanStarted = Date.now();
  let scannedFiles = 0;
  let maskedCount = 0;
  const excluded = [...exclusions];
  const roots = dedupeRoots(scanRoots)
    .filter((root) => !excluded.some((candidate) => isPathAtOrUnder(root, candidate)));
  const addScannedEnvMask = async (
    path: string,
    kind: "file" | "symlink",
  ): Promise<boolean> => {
    const before = directories.size + files.size;
    if (kind === "file") {
      addEntry(path, "file");
    } else {
      // 끊긴 링크는 읽을 내용이 없으므로 세션 시작을 막지 않고 건너뛴다.
      let real: string;
      try {
        real = await ports.resolveRealPath(path);
      } catch {
        return false;
      }
      const realFact = await ports.lstatPath(real);
      if (!realFact) return false;
      addEntry(real, realFact.kind === "directory" ? "directory" : "file");
    }
    return directories.size + files.size > before;
  };

  for (const root of roots) {
    const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
    while (pending.length > 0) {
      const current = pending.pop() as { path: string; depth: number };
      if (current.depth >= ENV_MASK_SCAN_MAX_DEPTH) continue;
      let entries: Awaited<ReturnType<IsolationHostPorts["listDirectory"]>>;
      try {
        entries = await ports.listDirectory(current.path);
      } catch {
        // 호스트가 읽지 못하는 디렉터리는 상자 안에서도 읽을 수 없다.
        continue;
      }
      for (const entry of entries) {
        const path = join(current.path, entry.name);
        if (excluded.some((candidate) => isPathAtOrUnder(path, candidate))) continue;
        if (entry.kind === "directory") {
          if (ENV_MASK_SCAN_SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
          pending.push({ path, depth: current.depth + 1 });
          continue;
        }
        if (entry.kind !== "file" && entry.kind !== "symlink") continue;
        scannedFiles += 1;
        if (!isEnvMaskTargetName(entry.name)) continue;
        if (await addScannedEnvMask(path, entry.kind)) maskedCount += 1;
      }
    }
  }
  const elapsedMs = Date.now() - scanStarted;

  for (const mask of args.extraMasks) {
    if (mask.kind === "directory") directories.set(mask.path, mask);
    else files.set(mask.path, mask);
  }

  // 10. 겹친 가림 정리. 디렉터리 mask 아래의 다른 가림은 그 사이에 다시 여는
  // bind가 없으면 효력이 없다. 계획에서 빼서 빈 뼈대 디렉터리(/mnt/c/.../.azure)를
  // 만들지 않는다.
  dropCoveredMasks(directories, files, rebindings);

  return {
    masks: [...directories.values()].sort(byPath).concat([...files.values()].sort(byPath)),
    rebindings,
    envScan: {
      roots: roots.length,
      files: scannedFiles,
      masked: maskedCount,
      elapsedMs,
    },
  };
}

/**
 * 상위 디렉터리 mask에 덮이는 가림을 뺀다. 단, 그 사이에 다시 여는 bind가 있으면
 * 그 아래 가림은 실제로 효력이 있으므로 남긴다.
 */
function dropCoveredMasks(
  directories: Map<string, IsolationMask>,
  files: Map<string, IsolationMask>,
  rebindings: readonly MountBinding[],
): void {
  const ancestors = [...directories.keys()];
  const reopenedBetween = (ancestor: string, path: string): boolean =>
    rebindings.some((binding) =>
      binding.destination !== ancestor
      && isPathAtOrUnder(binding.destination, ancestor)
      && isPathAtOrUnder(path, binding.destination),
    );
  const covered = (path: string, self: string | null): boolean =>
    ancestors.some((ancestor) =>
      ancestor !== self
      && isPathAtOrUnder(path, ancestor)
      && !reopenedBetween(ancestor, path),
    );

  for (const path of [...files.keys()]) {
    if (covered(path, null)) files.delete(path);
  }
  for (const path of [...directories.keys()]) {
    if (covered(path, path)) directories.delete(path);
  }
}
