import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type {
  HostDirectoryEntry,
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
  /** 뿌리 탐색 결과를 캐시에서 되쓴 횟수. */
  cacheHits: number;
  /** 뿌리를 실제로 다시 훑은 횟수. */
  cacheMisses: number;
  /** 나열한 디렉터리 수(캐시 적중분 포함). */
  directories: number;
  /** 이 호출이 `scanEnvMaskRoot`를 직접 시작한 뿌리 수. */
  walkedRoots: number;
  /** 진행 중인 다른 호출의 순회를 함께 기다린 뿌리 수. `walkedRoots + joinedRoots`는 `cacheMisses`다. */
  joinedRoots: number;
  /** 동기 나열에 쓴 누적 시간(ms). 직접 훑은 뿌리만 센다. */
  listMs: number;
  /** 심볼릭 링크 확인에 쓴 누적 시간(ms). 직접 훑은 뿌리만 센다. */
  linkMs: number;
  /** 이벤트 루프에 양보한 횟수. 직접 훑은 뿌리만 센다. */
  yields: number;
  /** 양보에서 돌아오기까지 기다린 누적 시간(ms). 직접 훑은 뿌리만 센다. */
  yieldMs: number;
  /** 한 뿌리라도 다시 훑었으면 `miss`, 전부 캐시면 `hit`, 섞이면 `mixed`. */
  cache: "hit" | "miss" | "mixed";
  elapsedMs: number;
}

export interface IsolationMaskPlan {
  /** 디렉터리 mask를 먼저, 민감 파일 mask를 마지막에 둔다. */
  masks: IsolationMask[];
  /** mask한 부모 아래에서 RO로 다시 여는 경로. */
  rebindings: MountBinding[];
  /** `.env` 가림 탐색 통계. 로그로만 쓴다. */
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
  // 빌드·시험·도구 산출물. 세션 `.env` 설정의 원본이 놓이는 곳이 아니고,
  // 훑으면 디렉터리 수만 크게 늘린다.
  "public",
  "dist",
  "build",
  "out",
  "coverage",
  ".vite",
  ".turbo",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  ".gradle",
  "site-packages",
]);

/**
 * 뿌리(깊이 0)에서 나열하는 최대 디렉터리 깊이. 뿌리 자신과 바로 아래 폴더까지다.
 * 훑는 범위는 폴더 이름이 아니라 뿌리 목록이 정한다.
 */
const ENV_MASK_SCAN_MAX_DIRECTORY_DEPTH = 1;

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

/** 뿌리별 탐색 결과를 다시 쓰는 시간. 지나면 다시 훑는다. */
export const ENV_MASK_SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 동기 순회가 이벤트 루프에 양보하기 전까지 일하는 시간. 디렉터리 나열이
 * 비동기가 아니어도 긴 순회가 다른 작업을 오래 막지 않게 한다.
 */
const ENV_MASK_SCAN_YIELD_INTERVAL_MS = 10;

/** 순회가 오래 이어져도 다른 작업이 굶지 않게 이벤트 루프에 양보한다. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 로그에 싣는 ms 값은 소수 첫째 자리로 줄인다. */
function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 캐시한 탐색 결과가 유효한 탐색 규칙인지 가르는 지문. */
const ENV_MASK_SCAN_RULE_KEY = [
  `layers=${ENV_MASK_SCAN_MAX_DIRECTORY_DEPTH}`,
  `skip=${[...ENV_MASK_SCAN_SKIPPED_DIRECTORY_NAMES].sort().join(",")}`,
  `exclude=${[...ENV_MASK_SCAN_EXCLUDED_SUFFIXES].sort().join(",")}`,
].join("|");

/**
 * 훑는 데 필요한 호스트 포트만. 디렉터리 나열과 심볼릭 링크 확인 모두 동기
 * 포트를 써서 서비스가 공유하는 libuv 스레드풀(기본 4)을 기다리지 않는다.
 * 그래서 스캔 안의 await는 이벤트 루프 양보뿐이다. 시험과 측정이 가짜·실제
 * 포트를 그대로 넘긴다.
 */
export type EnvMaskScanPorts = Pick<
  IsolationHostPorts,
  "listDirectorySync" | "lstatPathSync" | "resolveRealPathSync"
>;

export interface ScannedEnvMaskEntry {
  /** 탐색에서 만난 원래 경로. 세션별 쓰기 경로 판정에 함께 쓴다. */
  source: string;
  /** bwrap에 놓을 가림 경로. 심볼릭 링크는 실경로다. */
  path: string;
  kind: "file" | "directory";
}

export interface EnvMaskRootScanResult {
  entries: ScannedEnvMaskEntry[];
  /** 이름을 확인한 파일·심볼릭 링크 수. */
  files: number;
  /** 나열한 디렉터리 수. */
  directories: number;
  /** 동기 나열에 쓴 시간(ms). */
  listMs: number;
  /** 심볼릭 링크 확인에 쓴 시간(ms). */
  linkMs: number;
  /** 이벤트 루프에 양보한 횟수. */
  yields: number;
  /** 양보에서 돌아오기까지 기다린 시간(ms). */
  yieldMs: number;
}

export interface EnvMaskScanResult {
  rootScans: EnvMaskRootScanResult[];
  files: number;
  /** 나열한 디렉터리 수(캐시 적중분 포함). */
  directories: number;
  cacheHits: number;
  cacheMisses: number;
  /** 이 호출이 직접 시작한 순회 수. */
  walkedRoots: number;
  /** 진행 중인 순회를 함께 기다린 수. `walkedRoots + joinedRoots`는 `cacheMisses`다. */
  joinedRoots: number;
  /** 직접 훑은 뿌리의 동기 나열 누적 시간(ms, 소수 첫째 자리). */
  listMs: number;
  /** 직접 훑은 뿌리의 링크 확인 누적 시간(ms, 소수 첫째 자리). */
  linkMs: number;
  /** 직접 훑은 뿌리의 양보 횟수. */
  yields: number;
  /** 직접 훑은 뿌리의 양보 대기 누적 시간(ms, 소수 첫째 자리). */
  yieldMs: number;
  elapsedMs: number;
}

interface CachedEnvMaskRootScan {
  expiresAt: number;
  entries: readonly ScannedEnvMaskEntry[];
  files: number;
  directories: number;
}

/**
 * 노드 프로세스 안에서 뿌리별 탐색 결과를 나눠 쓴다. 캐시에는 세션 공통 제외만
 * 반영되고, 세션마다 다른 쓰기 경로는 `prepareIsolationMasks`가 매번 건다.
 */
const envMaskScanCache = new Map<string, CachedEnvMaskRootScan>();

/**
 * 진행 중인 뿌리 탐색. 같은 열쇠(규칙·공통 제외·뿌리)의 요청이 겹치면 새로
 * 훑지 않고 이 Promise를 함께 기다린다. 같은 뿌리를 동시에 훑는 두 요청이
 * 디렉터리를 두 번 나열하며 서로를 기다리는 일을 막는다.
 */
const envMaskScanInFlight = new Map<string, Promise<EnvMaskRootScanResult>>();

/** 뿌리별 무효화 세대. 훑는 도중 무효화된 결과를 캐시에 넣지 않는 데 쓴다. */
const envMaskScanInvalidationEpoch = new Map<string, number>();

/** 시험과 측정에서 캐시 상태를 초기화할 때만 쓴다. */
export function clearEnvMaskScanCache(): void {
  envMaskScanCache.clear();
}

/**
 * 뿌리 하나의 캐시를 무효화한다. 캐시 열쇠 끝의 뿌리 부분이 같은 항목을 모두
 * 지우고, 그 뿌리의 탐색이 아직 진행 중이면 그 결과도 캐시에 넣지 않아 다음
 * 요청이 다시 훑는다. 실경로로 캐시된 항목도 함께 지운다.
 */
export function invalidateEnvMaskScanRoot(root: string): void {
  invalidateEnvMaskScanRootKey(root);
  try {
    const real = realpathSync(root);
    if (real !== root) invalidateEnvMaskScanRootKey(real);
  } catch {
    // 아직 없는 뿌리는 지울 캐시가 없다.
  }
}

function invalidateEnvMaskScanRootKey(root: string): void {
  envMaskScanInvalidationEpoch.set(
    root,
    (envMaskScanInvalidationEpoch.get(root) ?? 0) + 1,
  );
  const suffix = `\n${root}`;
  for (const key of [...envMaskScanCache.keys()]) {
    if (key.endsWith(suffix)) envMaskScanCache.delete(key);
  }
  for (const key of [...envMaskScanInFlight.keys()]) {
    if (key.endsWith(suffix)) envMaskScanInFlight.delete(key);
  }
}

/** `path`가 `root`와 같거나 그 아래인지 구성 요소 경계로 판정한다. */
function isPathAtOrUnder(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

/**
 * 뿌리 하나를 명시 스택으로 훑어 `.env` 후보를 모은다. 나열하는 층은 뿌리
 * 자신(깊이 0)과 뿌리 바로 아래 폴더(깊이 1)까지다. 디렉터리 나열과 심볼릭 링크
 * 확인은 동기 포트로 해 스레드풀을 쓰지 않고, 약
 * `ENV_MASK_SCAN_YIELD_INTERVAL_MS`마다 이벤트 루프에 양보한다. 나열 층·건너뛸
 * 이름·대상 이름 판정은 `ENV_MASK_SCAN_RULE_KEY`에 들어 있어 규칙이 바뀌면
 * 캐시가 갈린다.
 */
async function scanEnvMaskRoot(
  root: string,
  ports: EnvMaskScanPorts,
  commonExclusions: readonly string[],
): Promise<EnvMaskRootScanResult> {
  const entries: ScannedEnvMaskEntry[] = [];
  let files = 0;
  let directories = 0;
  let listMs = 0;
  let linkMs = 0;
  let yields = 0;
  let yieldMs = 0;
  const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  const excluded = (path: string): boolean =>
    commonExclusions.some((candidate) => isPathAtOrUnder(path, candidate));
  let lastYieldAt = performance.now();

  while (pending.length > 0) {
    if (performance.now() - lastYieldAt >= ENV_MASK_SCAN_YIELD_INTERVAL_MS) {
      const yieldStarted = performance.now();
      await yieldToEventLoop();
      yieldMs += performance.now() - yieldStarted;
      yields += 1;
      lastYieldAt = performance.now();
    }
    const current = pending.pop();
    if (!current || current.depth > ENV_MASK_SCAN_MAX_DIRECTORY_DEPTH) continue;
    let entriesInDirectory: HostDirectoryEntry[];
    const listStarted = performance.now();
    try {
      entriesInDirectory = ports.listDirectorySync(current.path);
    } catch {
      // 호스트가 읽지 못하는 디렉터리는 상자 안에서도 읽을 수 없다.
      listMs += performance.now() - listStarted;
      continue;
    }
    listMs += performance.now() - listStarted;
    directories += 1;
    for (const entry of entriesInDirectory) {
      const path = join(current.path, entry.name);
      if (excluded(path)) continue;
      if (entry.kind === "directory") {
        if (ENV_MASK_SCAN_SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        const childDepth = current.depth + 1;
        if (childDepth > ENV_MASK_SCAN_MAX_DIRECTORY_DEPTH) continue;
        pending.push({ path, depth: childDepth });
        continue;
      }
      if (entry.kind !== "file" && entry.kind !== "symlink") continue;
      files += 1;
      if (!isEnvMaskTargetName(entry.name)) continue;
      if (entry.kind === "file") {
        entries.push({ source: path, path, kind: "file" });
        continue;
      }
      // 끊긴 링크는 읽을 내용이 없으므로 세션 시작을 막지 않고 건너뛴다.
      let real: string;
      const linkStarted = performance.now();
      try {
        real = ports.resolveRealPathSync(path);
      } catch {
        linkMs += performance.now() - linkStarted;
        continue;
      }
      linkMs += performance.now() - linkStarted;
      // 링크가 세션 쓰기 경로를 가리키면 그 안의 파일을 덮지 않는다.
      if (excluded(real)) continue;
      const factStarted = performance.now();
      const realFact = ports.lstatPathSync(real);
      linkMs += performance.now() - factStarted;
      if (!realFact) continue;
      entries.push({
        source: path,
        path: real,
        kind: realFact.kind === "directory" ? "directory" : "file",
      });
    }
  }
  return { entries, files, directories, listMs, linkMs, yields, yieldMs };
}

/**
 * 뿌리별로 캐시를 확인해 탐색한다. 캐시는 뿌리 실경로와 탐색 규칙이 같을 때만
 * 재사용하고, 세션 공통 제외는 탐색 자체에서 건너뛴다.
 */
export async function scanEnvMaskRoots(
  roots: readonly string[],
  ports: EnvMaskScanPorts,
  commonExclusions: readonly string[] = [],
): Promise<EnvMaskScanResult> {
  const started = Date.now();
  // 공통 제외가 다르면 탐색 결과도 달라진다. 열쇠에 정렬해 넣어 캐시가 갈리게 한다.
  const commonExclusionKey = [...new Set(commonExclusions)].sort().join("\n");
  const rootScans: EnvMaskRootScanResult[] = [];
  let files = 0;
  let directories = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let walkedRoots = 0;
  let joinedRoots = 0;
  let listMs = 0;
  let linkMs = 0;
  let yields = 0;
  let yieldMs = 0;
  for (const root of roots) {
    const key = `${ENV_MASK_SCAN_RULE_KEY}\ncommon=${commonExclusionKey}\n${root}`;
    const now = Date.now();
    const cached = envMaskScanCache.get(key);
    if (cached && cached.expiresAt > now) {
      cacheHits += 1;
      // 캐시 적중은 지금 훑은 것이 아니므로 시간·양보 계측은 0이다.
      rootScans.push({
        entries: [...cached.entries],
        files: cached.files,
        directories: cached.directories,
        listMs: 0,
        linkMs: 0,
        yields: 0,
        yieldMs: 0,
      });
      files += cached.files;
      directories += cached.directories;
      continue;
    }
    // 같은 열쇠의 탐색이 이미 돌고 있으면 새로 훑지 않고 그 결과를 함께
    // 기다린다. 기다린 요청은 캐시에서 되쓴 것이 아니므로 miss로 셈하고,
    // 디렉터리 나열은 한 번만 일어난다.
    cacheMisses += 1;
    const inFlight = envMaskScanInFlight.get(key);
    let scanned: EnvMaskRootScanResult;
    if (inFlight) {
      joinedRoots += 1;
      scanned = await inFlight;
    } else {
      walkedRoots += 1;
      const invalidationEpoch = envMaskScanInvalidationEpoch.get(root) ?? 0;
      let pending!: Promise<EnvMaskRootScanResult>;
      pending = scanEnvMaskRoot(root, ports, commonExclusions)
        .then((result) => {
          // 훑는 도중 이 뿌리가 무효화됐으면 결과를 캐시에 넣지 않는다.
          if ((envMaskScanInvalidationEpoch.get(root) ?? 0) === invalidationEpoch) {
            envMaskScanCache.set(key, {
              // 적중해도 만료를 늘리지 않는다. 훑은 시점에서 5분이다.
              expiresAt: Date.now() + ENV_MASK_SCAN_CACHE_TTL_MS,
              entries: result.entries,
              files: result.files,
              directories: result.directories,
            });
          }
          return result;
        })
        .finally(() => {
          // 실패했으면 진행 표시를 지워 다음 요청이 다시 훑게 한다. 무효화가
          // 지운 자리에 같은 열쇠의 새 탐색이 들어섰으면 그 표시는 남긴다.
          if (envMaskScanInFlight.get(key) === pending) {
            envMaskScanInFlight.delete(key);
          }
        });
      envMaskScanInFlight.set(key, pending);
      scanned = await pending;
      // 계측 합은 직접 훑은 뿌리만 센다. 함께 기다린 요청과 겹쳐 세지 않는다.
      listMs += scanned.listMs;
      linkMs += scanned.linkMs;
      yields += scanned.yields;
      yieldMs += scanned.yieldMs;
    }
    rootScans.push(scanned);
    files += scanned.files;
    directories += scanned.directories;
  }
  return {
    rootScans,
    files,
    directories,
    cacheHits,
    cacheMisses,
    walkedRoots,
    joinedRoots,
    listMs: roundMs(listMs),
    linkMs: roundMs(linkMs),
    yields,
    yieldMs: roundMs(yieldMs),
    elapsedMs: Date.now() - started,
  };
}

function byPath(left: IsolationMask, right: IsolationMask): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/**
 * 같은 경로의 뿌리를 하나로 합친다. 한 층 규칙에서는 상위 뿌리를 훑어도 하위
 * 뿌리의 바로 아래 층은 나열되지 않으므로(예: 작업 폴더 아래 워크트리 뿌리)
 * 포함 관계로 지우지 않는다.
 */
function dedupeRoots(roots: Iterable<string>): string[] {
  return [...new Set(roots)];
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

  const addEntry = (
    path: string,
    kind: IsolationMask["kind"],
    writable = false,
  ): void => {
    const entries = kind === "directory" ? directories : files;
    const existing = entries.get(path);
    if (existing) {
      // 같은 경로가 쓰기 허용으로 한 번이라도 올라오면 그 뜻을 잃지 않는다.
      if (writable && kind === "directory") existing.writable = true;
      return;
    }
    entries.set(
      path,
      writable && kind === "directory" ? { path, kind, writable: true } : { path, kind },
    );
  };

  const addMask = async (
    path: string,
    required: boolean,
    writable = false,
  ): Promise<void> => {
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
      addEntry(
        real,
        realFact.kind === "directory" ? "directory" : "file",
        writable,
      );
      return;
    }

    addEntry(path, fact.kind === "directory" ? "directory" : "file", writable);
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
    addEntry(real, realFact.kind === "directory" ? "directory" : "file", writable);
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

  // 3. user bus·keyring. `/run/user/<uid>`는 사용자 매니저가 뜰 때만 있어
  // 마스크 계산과 bwrap 실행 사이에 없어질 수 있다. 그때 bwrap은 `--ro-bind / /`
  // 위에 자리를 못 만들어 exit 1로 죽으므로, 늘 있는 부모를 가린다.
  await addMask("/run/user", false);

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

  // 6. 노드별 민감 루트. 정책이 쓰기 허용으로 지목한 루트만 세션별 빈
  // 쓰기 tmpfs로 두고, 나머지는 지금처럼 읽기 전용으로 잠근다.
  const writableSensitiveRoots = new Set(
    input.policy.filesystem.writableSensitiveRoots,
  );
  for (const root of input.policy.filesystem.additionalSensitiveRoots) {
    await addMask(root, false, writableSensitiveRoots.has(root));
  }

  // 6b. 노드 incoming 루트. 정책 mask가 덮지 않는 배치에서도 다른 세션의 첨부가
  // 보이지 않게 늘 가리고, 이 세션 폴더만 plan이 RO로 다시 연다.
  await addMask(input.incomingRoot, false);

  // `.env` 가림 탐색에 쓸 RO 재노출 뿌리. mask 아래에서 다시 여는 경로는
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

  // 9. `.env` 가림. 상자에 RO로 다시 여는 경로(호스트 워크스페이스 루트,
  // readOnlyReexposedPaths, 공통 파일 디렉터리, 서비스 env 디렉터리)와 설정이
  // 지목한 뿌리(워크트리 프로젝트 뿌리, 프로필 workspace_dir, 정책
  // `envMaskScanRoots`)의 정해진 층을 훑는다. 세션이 쓸 수 있게 연 경로 아래는
  // 자기 작업물이므로 뺀다.
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
  // 설정이 지목한 뿌리. 절대 경로가 아니거나 없는 경로는 조용히 건너뛴다.
  // 폴더 이름으로 훑는 범위를 정하지 않는다.
  if (input.projectsRoot && isAbsolute(input.projectsRoot)) {
    addScanRoot(await directoryReal(input.projectsRoot));
  }
  for (const workspaceDir of input.agentWorkspaceDirs ?? []) {
    if (!isAbsolute(workspaceDir)) continue;
    addScanRoot(await directoryReal(workspaceDir));
  }
  for (const policyRoot of input.policy.filesystem.envMaskScanRoots ?? []) {
    addScanRoot(await directoryReal(policyRoot));
  }

  const resolveExclusions = async (
    paths: readonly string[],
  ): Promise<string[]> => {
    const resolved = new Set<string>();
    for (const path of paths) {
      resolved.add(path);
      try {
        resolved.add(await ports.resolveRealPath(path));
      } catch {
        // 아직 없는 쓰기 경로(예: 이번 턴에 만들 .local/tmp)는 원래 경로로 충분하다.
      }
    }
    return [...resolved];
  };
  const roots = dedupeRoots(scanRoots);
  // 모든 세션에 같은 제외. 캐시된 탐색 결과에도 같게 적용되므로 탐색 자체에서
  // 뺀다. `.local` 아래 쓰기 경로는 호스트 작업 폴더뿐 아니라 어떤 뿌리에서
  // 연 것이든 세션의 작업 공간이므로 뿌리마다 걸어 둔다.
  const commonExclusions = await resolveExclusions([
    join(hostRoot, ".local/tmp"),
    join(hostRoot, ".local/artifacts"),
    ...roots.flatMap((root) => [
      join(root, ".local/tmp"),
      join(root, ".local/artifacts"),
    ]),
    join(input.homeDirectory, input.policy.filesystem.isolatedCacheRelativeRoot),
  ]);
  // 세션마다 다른 쓰기 경로. 캐시를 나눠 써도 결과가 캐시 없이 훑은 것과 같도록
  // 탐색 결과에 매번 건다.
  const sessionExclusions = await resolveExclusions([
    join(
      hostRoot,
      input.policy.filesystem.sessionWorktreeRelativeRoot,
      input.decision.sessionId,
    ),
    join(input.sessionDirectory, "sandbox"),
    // scratch가 호스트 워크스페이스 루트 자체면 그 루트는 RO bind라 탐색 뿌리로
    // 남긴다. 그 아래 워크트리는 이미 별도로 뺀다.
    ...(isPathAtOrUnder(hostRoot, input.scratchWorkspaceDir)
      ? []
      : [input.scratchWorkspaceDir]),
    ...input.ownedWorktrees.map((attachment) => attachment.canonicalPath),
    ...input.attachedWorktrees.map((attachment) => attachment.canonicalPath),
  ]);

  const filteredRoots = roots.filter((root) =>
    !commonExclusions.some((candidate) => isPathAtOrUnder(root, candidate)),
  );
  const scan = await scanEnvMaskRoots(filteredRoots, ports, commonExclusions);
  const scannedFiles = scan.files;
  let maskedCount = 0;
  for (const rootScan of scan.rootScans) {
    for (const entry of rootScan.entries) {
      if (
        sessionExclusions.some((candidate) =>
          isPathAtOrUnder(entry.source, candidate)
          || isPathAtOrUnder(entry.path, candidate),
        )
      ) {
        continue;
      }
      const before = directories.size + files.size;
      addEntry(entry.path, entry.kind);
      if (directories.size + files.size > before) maskedCount += 1;
    }
  }
  const elapsedMs = scan.elapsedMs;

  for (const mask of args.extraMasks) {
    if (mask.kind === "directory") directories.set(mask.path, mask);
    else files.set(mask.path, mask);
  }

  return {
    masks: [...directories.values()].sort(byPath).concat([...files.values()].sort(byPath)),
    rebindings,
    envScan: {
      roots: filteredRoots.length,
      files: scannedFiles,
      masked: maskedCount,
      cacheHits: scan.cacheHits,
      cacheMisses: scan.cacheMisses,
      directories: scan.directories,
      walkedRoots: scan.walkedRoots,
      joinedRoots: scan.joinedRoots,
      listMs: scan.listMs,
      linkMs: scan.linkMs,
      yields: scan.yields,
      yieldMs: scan.yieldMs,
      cache: scan.cacheMisses > 0 && scan.cacheHits > 0
        ? "mixed"
        : scan.cacheMisses > 0
          ? "miss"
          : "hit",
      elapsedMs,
    },
  };
}

/**
 * 상위 디렉터리 mask에 덮이는 가림을 뺀다. 최종 bind 목록(spec.bindings와
 * heavyWorkLockBindings)을 받는다. 사이에 다시 여는 bind가 있으면 그 아래 가림은
 * 효력이 있으므로 남기고, 같은 경로의 bind도 다시 여는 것으로 본다.
 */
export function dropCoveredMasks(
  masks: readonly IsolationMask[],
  bindings: readonly MountBinding[],
): IsolationMask[] {
  const ancestors = masks
    .filter((mask) => mask.kind === "directory")
    .map((mask) => mask.path);
  const reopenedBetween = (ancestor: string, path: string): boolean =>
    bindings.some(
      (binding) =>
        isPathAtOrUnder(binding.destination, ancestor)
        && isPathAtOrUnder(path, binding.destination),
    );
  const covered = (path: string, self: string | null): boolean =>
    ancestors.some(
      (ancestor) =>
        ancestor !== self
        && isPathAtOrUnder(path, ancestor)
        && !reopenedBetween(ancestor, path),
    );
  return masks.filter((mask) =>
    mask.kind === "directory"
      ? !covered(mask.path, mask.path)
      : !covered(mask.path, null),
  );
}
