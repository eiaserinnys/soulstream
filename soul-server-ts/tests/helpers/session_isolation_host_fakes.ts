import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import type { ResolvedMcpServer } from "../../src/mcp_config_service.js";
import type {
  HostPathFact,
  IsolationHostPorts,
  IsolationPolicy,
} from "../../src/security/session_isolation_contract.js";

/** 테스트에서만 쓰는 호스트 사실 대체값. 실제 시스템 경로를 건드리지 않는다. */
export interface FakeSystemFact {
  kind: HostPathFact["kind"];
  realPath?: string;
  nlink?: number;
}

export interface FakeHostPortsOptions {
  /** 모든 임시 파일이 놓이는 mkdtemp 루트. 이 밖의 실제 경로는 읽지 않는다. */
  root: string;
  nodeId?: string;
  wsl?: boolean;
  systemFacts?: Record<string, FakeSystemFact | null>;
  /** 가상의 절대 경로(/tmp/soulstream-heavy-verify...)를 임시 파일로 잇는다. */
  lockFilePaths?: Record<string, string>;
  mainStorePath?: string | null;
  agentCommonFilesDir?: string | null;
  claudeOauthToken?: string;
  gitCommonDirs?: Record<string, string>;
  githubCredential?: Record<string, string>;
  sanitizeMcpServers?: (
    servers: readonly ResolvedMcpServer[],
    policy: IsolationPolicy,
  ) => Promise<readonly ResolvedMcpServer[]>;
}

export interface FakeHostPorts extends IsolationHostPorts {
  calls: {
    ensureLockFile: string[];
    verifyAuthPreparation: number;
    sanitizeMcpServers: number;
    issueRestrictedCredential: string[];
  };
}

function factOf(path: string, nlink?: number): HostPathFact {
  const stats = lstatSync(path);
  const kind: HostPathFact["kind"] = stats.isSymbolicLink()
    ? "symlink"
    : stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : "other";
  return { kind, dev: Number(stats.dev), ino: Number(stats.ino), nlink: nlink ?? stats.nlink };
}

/**
 * 실제 syscall을 흉내 내되 시스템 경로는 명시한 가짜 사실로만 답하는 포트.
 * root 밖의 경로는 lstat/realpath 모두 `null`/거절이라 실제 ~/.codex 같은
 * 운영 파일을 읽지 않는다.
 */
export function createFakeHostPorts(options: FakeHostPortsOptions): FakeHostPorts {
  const { root } = options;
  const systemFacts = options.systemFacts ?? {};
  const lockFilePaths = options.lockFilePaths ?? {};
  const gitCommonDirs = options.gitCommonDirs ?? {};
  const calls: FakeHostPorts["calls"] = {
    ensureLockFile: [],
    verifyAuthPreparation: 0,
    sanitizeMcpServers: 0,
    issueRestrictedCredential: [],
  };

  const inside = (path: string): boolean => {
    if (!isAbsolute(path)) return false;
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };

  const systemFactEntries = Object.entries(systemFacts);

  const systemFact = (path: string): HostPathFact | null | undefined => {
    if (!(path in systemFacts)) return undefined;
    const entry = systemFacts[path];
    if (entry === null) return null;
    const index = systemFactEntries.findIndex(([candidate]) => candidate === path);
    return { kind: entry.kind, dev: 1, ino: 9000 + index, nlink: entry.nlink ?? 1 };
  };

  const ports: FakeHostPorts = {
    calls,
    async lstatPath(path: string): Promise<HostPathFact | null> {
      const override = systemFact(path);
      if (override !== undefined) return override;
      const mappedLock = lockFilePaths[path];
      if (mappedLock) return existsSync(mappedLock) ? factOf(mappedLock) : null;
      if (!inside(path)) return null;
      try {
        return factOf(path);
      } catch {
        return null;
      }
    },
    async listDirectory(path: string) {
      const override = systemFact(path);
      if (override === null) throw new Error(`not a directory: ${path}`);
      if (override !== undefined) return [];
      if (!inside(path)) throw new Error(`not a directory: ${path}`);
      return readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "other",
      }));
    },
    async readSymlink(path: string): Promise<string | null> {
      const override = systemFact(path);
      if (override !== undefined) {
        return override?.kind === "symlink" ? (override.realPath ?? null) : null;
      }
      if (!inside(path)) return null;
      try {
        if (!lstatSync(path).isSymbolicLink()) return null;
      } catch {
        return null;
      }
      return readlinkSync(path);
    },
    async detectWsl(): Promise<boolean> {
      return options.wsl ?? false;
    },
    async ensureDirectory(path: string, mode: number): Promise<void> {
      if (!inside(path)) throw new Error(`refusing directory outside temp root: ${path}`);
      mkdirSync(path, { recursive: true, mode });
      chmodSync(path, mode);
      if (!lstatSync(path).isDirectory()) throw new Error(`not a directory: ${path}`);
    },
    async writeFile(path: string, contents: string, mode: number): Promise<void> {
      if (!inside(path)) throw new Error(`refusing write outside temp root: ${path}`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, contents, { mode });
      chmodSync(path, mode);
    },
    async copyFile(source: string, destination: string, mode: number): Promise<void> {
      if (!inside(source) || !inside(destination)) {
        throw new Error(`refusing copy outside temp root: ${source}`);
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination);
      chmodSync(destination, mode);
    },
    async resolveRealPath(path: string): Promise<string> {
      const override = systemFact(path);
      if (override !== undefined) {
        if (override === null) throw new Error(`ENOENT: ${path}`);
        return override.realPath ?? path;
      }
      const mappedLock = lockFilePaths[path];
      if (mappedLock) return realpathSync(mappedLock);
      if (!inside(path)) throw new Error(`ENOENT: ${path}`);
      return realpathSync(path);
    },
    async verifyAuthPreparation(): Promise<void> {
      calls.verifyAuthPreparation += 1;
    },
    async prepareGitHubCredential(): Promise<Record<string, string>> {
      return options.githubCredential ?? { GH_TOKEN: "fake-gh-token" };
    },
    async issueRestrictedCredential(sessionId: string): Promise<string> {
      calls.issueRestrictedCredential.push(sessionId);
      return `ssr1.${sessionId}.fake-signature`;
    },
    async sanitizeMcpServers(servers, policy) {
      calls.sanitizeMcpServers += 1;
      if (options.sanitizeMcpServers) return options.sanitizeMcpServers(servers, policy);
      return servers;
    },
    async ensureLockFile(path: string, mode: number): Promise<void> {
      calls.ensureLockFile.push(path);
      const actual = lockFilePaths[path];
      if (!actual) throw new Error(`unmapped lock path: ${path}`);
      if (existsSync(actual)) {
        const stats = lstatSync(actual);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new Error(`lock path is not a regular file: ${path}`);
        }
      }
      closeSync(openSync(actual, "a", mode));
      chmodSync(actual, mode);
      if (!lstatSync(actual).isFile()) throw new Error(`lock path is not a file: ${path}`);
    },
    async ensureSymlink(target: string, path: string): Promise<void> {
      if (!inside(path)) throw new Error(`refusing symlink outside temp root: ${path}`);
      let existing: ReturnType<typeof lstatSync> | null = null;
      try {
        existing = lstatSync(path);
      } catch {
        existing = null;
      }
      if (existing) {
        if (!existing.isSymbolicLink() || readlinkSync(path) !== target) {
          throw new Error(`conflicting symlink: ${path}`);
        }
        return;
      }
      symlinkSync(target, path);
    },
    async hashFileSha512(path: string): Promise<string> {
      if (!inside(path)) throw new Error(`refusing hash outside temp root: ${path}`);
      return createHash("sha512").update(readFileSync(path)).digest("hex");
    },
    async resolveGitCommonDir(repositoryPath: string): Promise<string> {
      const resolved = gitCommonDirs[repositoryPath] ?? join(repositoryPath, ".git");
      if (!inside(resolved) || !existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
        throw new Error(`git common dir unavailable: ${repositoryPath}`);
      }
      return realpathSync(resolved);
    },
    async resolveNodeId(): Promise<string> {
      return options.nodeId ?? "node-a";
    },
    async resolveMainPackageStorePath(): Promise<string | null> {
      return options.mainStorePath ?? null;
    },
    async readClaudeOauthToken(): Promise<string> {
      if (options.claudeOauthToken === undefined) throw new Error("no claude oauth token");
      return options.claudeOauthToken;
    },
    async resolveAgentCommonFilesDirectory(): Promise<string | null> {
      return options.agentCommonFilesDir ?? null;
    },
  };

  return ports;
}

/** 테스트 픽스처용으로 디렉터리/파일을 만든다(모두 temp root 아래). */
export function touch(
  root: string,
  relativePath: string,
  contents = "",
  mode = 0o600,
): string {
  const path = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}
