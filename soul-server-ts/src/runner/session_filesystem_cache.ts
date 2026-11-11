import { join } from "node:path";

import type {
  IsolationHostPorts,
  IsolationPreparationInput,
  MountBinding,
} from "../security/session_isolation_contract.js";
import {
  IsolationSharedDependencyInodeError,
  SessionIsolationUnavailableError,
} from "./session_filesystem_errors.js";

/** §9 노드별 공유 격리 캐시 하위 디렉터리. */
export const ISOLATED_CACHE_DIRECTORY_NAMES = [
  "pnpm-store",
  "npm",
  "xdg",
  "corepack",
  "pip",
  "uv",
  "cargo",
  "sccache",
] as const;

const MAX_SAMPLED_ENTRIES = 4096;
const MAX_HASHED_FILES = 64;

export interface IsolatedCachePlan {
  /** 정규 절대 경로. write root 안내에 쓴다. */
  root: string;
  bindings: MountBinding[];
}

export interface PrepareIsolatedCacheArgs {
  input: IsolationPreparationInput;
  ports: IsolationHostPorts;
}

/** 캐시 디렉터리가 symlink로 다른 store를 가리키면 inode 공유로 취급한다. */
async function ensureCacheDirectory(
  ports: IsolationHostPorts,
  path: string,
): Promise<string> {
  const fact = await ports.lstatPath(path);
  if (fact?.kind === "symlink") {
    throw new IsolationSharedDependencyInodeError(
      `격리 캐시가 다른 저장소를 가리킵니다: ${path}`,
    );
  }
  if (fact && fact.kind !== "directory") {
    throw new SessionIsolationUnavailableError(
      `격리 캐시 경로가 디렉터리가 아닙니다: ${path}`,
    );
  }
  if (!fact) await ports.ensureDirectory(path, 0o700);
  return ports.resolveRealPath(path);
}

/** §9 공유 격리 캐시. restricted 세션끼리만 공유하고 full/운영은 쓰지 않는다. */
export async function prepareIsolatedCache(
  args: PrepareIsolatedCacheArgs,
): Promise<IsolatedCachePlan> {
  const { input, ports } = args;
  const rootInput = join(
    input.homeDirectory,
    input.policy.filesystem.isolatedCacheRelativeRoot,
  );
  const root = await ensureCacheDirectory(ports, rootInput);
  const bindings: MountBinding[] = [];
  for (const name of ISOLATED_CACHE_DIRECTORY_NAMES) {
    const path = await ensureCacheDirectory(ports, join(rootInput, name));
    bindings.push({ source: path, destination: path, writable: true });
  }
  return { root, bindings };
}

/** §9 restricted 도구 캐시 환경. B3가 최종 env에 합친다. */
export function isolatedCacheEnvironment(
  cacheRoot: string,
  homeDirectory: string,
): Record<string, string> {
  return {
    npm_config_store_dir: join(cacheRoot, "pnpm-store"),
    npm_config_cache: join(cacheRoot, "npm"),
    XDG_CACHE_HOME: join(cacheRoot, "xdg"),
    COREPACK_HOME: join(cacheRoot, "corepack"),
    PIP_CACHE_DIR: join(cacheRoot, "pip"),
    UV_CACHE_DIR: join(cacheRoot, "uv"),
    CARGO_HOME: join(cacheRoot, "cargo"),
    SCCACHE_DIR: join(cacheRoot, "sccache"),
    PLAYWRIGHT_BROWSERS_PATH: join(homeDirectory, ".cache/ms-playwright"),
  };
}

export interface AssertNoSharedInodesArgs {
  worktreeRoots: readonly string[];
  ports: IsolationHostPorts;
}

/**
 * §9 표본 검사. node_modules가 symlink이면 거부하고, nlink>1 파일의 SHA-512로
 * 주 store 후보를 찾아 dev/ino를 비교한다. 표본 통과는 전체 증명이 아니다.
 * 주 store 파일은 읽기만 하고 수정·삭제하지 않는다.
 */
export async function assertNoSharedMainStoreInodes(
  args: AssertNoSharedInodesArgs,
): Promise<void> {
  const { ports } = args;
  const mainStore = await ports.resolveMainPackageStorePath();
  if (!mainStore) return;

  for (const worktreeRoot of args.worktreeRoots) {
    const nodeModules = join(worktreeRoot, "node_modules");
    const nodeModulesFact = await ports.lstatPath(nodeModules);
    if (!nodeModulesFact) continue;
    if (nodeModulesFact.kind === "symlink") {
      throw new IsolationSharedDependencyInodeError(
        `node_modules가 symlink입니다: ${nodeModules} (격리 세션에는 create_worktree를 setup="none"으로 만든 워크트리를 붙이고, 의존성은 그 안에 독립 설치한다)`,
      );
    }
    if (nodeModulesFact.kind !== "directory") continue;

    const pending = [nodeModules];
    let visitedEntries = 0;
    let hashedFiles = 0;
    while (pending.length > 0 && visitedEntries < MAX_SAMPLED_ENTRIES) {
      const directory = pending.shift();
      if (!directory) break;
      const listing = await ports.listDirectory(directory);
      listing.sort((left, right) =>
        left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
      );
      for (const entry of listing) {
        if (visitedEntries >= MAX_SAMPLED_ENTRIES) break;
        if (hashedFiles >= MAX_HASHED_FILES) break;
        visitedEntries += 1;
        const child = join(directory, entry.name);
        if (entry.kind === "symlink") continue;
        if (entry.kind === "directory") {
          pending.push(child);
          continue;
        }
        if (entry.kind !== "file") continue;
        const fact = await ports.lstatPath(child);
        if (!fact || fact.nlink < 2) continue;
        const digest = await ports.hashFileSha512(child);
        const candidate = join(
          mainStore,
          "files",
          digest.slice(0, 2),
          digest.slice(2),
        );
        const candidateFact = await ports.lstatPath(candidate);
        if (
          candidateFact
          && candidateFact.dev === fact.dev
          && candidateFact.ino === fact.ino
        ) {
          throw new IsolationSharedDependencyInodeError(
            `의존성 파일이 주 store와 inode를 공유합니다: ${child}`,
          );
        }
        hashedFiles += 1;
      }
    }
  }
}
