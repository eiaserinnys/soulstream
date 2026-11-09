import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  createReadStream,
  type Dirent,
  type Stats,
} from "node:fs";
import {
  chmod,
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ResolvedMcpServer } from "../mcp_config_service.js";
import type {
  HostDirectoryEntry,
  HostPathFact,
  IsolatedAuthPreparation,
  IsolationHostPorts,
  IsolationPolicy,
} from "../security/session_isolation_contract.js";
import { createRestrictedMcpToken } from "../security/restricted_mcp_auth.js";
import { sanitizeRestrictedMcpServers } from "../security/restricted_mcp_config.js";
import {
  IsolationAuthUnavailableError,
  IsolationPreparationPolicyError,
  SessionIsolationUnavailableError,
} from "./session_filesystem_errors.js";
import {
  assertClaudeTokenFile,
  verifyCodexGrant,
} from "./session_isolation_host_ports_auth.js";

export { VERIFIED_CODEX_WRITER_VERSIONS } from "./session_isolation_host_ports_auth.js";

/**
 * B2(`prepareIsolationPlan`)가 실제 호스트에 부수효과를 일으키는 유일한 어댑터.
 *
 * - 세션마다 한 번 만들어 그 세션의 준비 계획에만 넘긴다.
 * - 토큰·인증 파일 내용은 메모리에서만 다루고 반환값·오류 메시지·로그에 넣지 않는다.
 * - 외부 명령(gh, git, pnpm, codex)은 `runCommand`로만 부른다. 시험은 가짜를 주입한다.
 * - 상위 디렉터리 생성은 B2(ensureDirectory)의 몫이며, 여기서 만들지 않는다.
 */

const DEFAULT_OSRELEASE_PATH = "/proc/sys/kernel/osrelease";
const GH_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 15_000;
const PNPM_TIMEOUT_MS = 30_000;
const MAX_COMMAND_BUFFER_BYTES = 1024 * 1024;

export type IsolationHostRunCommand = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string; env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface IsolationHostPortDependencies {
  sessionId: string;
  nodeId: string;
  /** host full AUTH_BEARER_TOKEN. ssr1 파생에만 쓰고 반환, 저장, 로그에 넣지 않는다 */
  hostBearerToken: string;
  actualInternalMcpUrl: string;
  homeDirectory: string;
  uid: number;
  agentCommonFilesDirectory: string | null;
  serviceEnvironmentDirectory: string | null;
  claudeTokenFile: string | null;
  /** restricted Codex가 실제로 띄울 실행 파일의 절대 경로. writer 판 확인에 쓴다 */
  codexExecutable: string | null;
  /** 시험 주입용. 기본값은 node:child_process execFile 기반 */
  runCommand?: IsolationHostRunCommand;
  /** 시험 주입용 커널 표식 경로. 기본 `/proc/sys/kernel/osrelease` */
  osreleasePath?: string;
}

function createDefaultRunCommand(): IsolationHostRunCommand {
  return (command, args, options) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...args],
        {
          timeout: options.timeoutMs,
          cwd: options.cwd,
          env: options.env,
          encoding: "utf8",
          maxBuffer: MAX_COMMAND_BUFFER_BYTES,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error === null ? 0 : numericExitCode(error),
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
        },
      );
    });
}

function numericExitCode(error: unknown): number {
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : -1;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function kindOfStats(stats: Stats): HostPathFact["kind"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

function kindOfDirent(entry: Dirent): HostPathFact["kind"] {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

function toHostPathFact(stats: Stats): HostPathFact {
  return {
    kind: kindOfStats(stats),
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    nlink: Number(stats.nlink),
  };
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

/** resolved token cache. 프로세스당 한 번만 `pnpm store path`를 부른다. */
let mainPackageStorePathPromise: Promise<string | null> | null = null;

/** 시험이 모듈 범위 캐시를 비울 때만 쓴다. */
export function resetMainPackageStorePathCacheForTests(): void {
  mainPackageStorePathPromise = null;
}

export function createIsolationHostPorts(
  deps: IsolationHostPortDependencies,
): IsolationHostPorts {
  const runCommand = deps.runCommand ?? createDefaultRunCommand();
  const osreleasePath = deps.osreleasePath ?? DEFAULT_OSRELEASE_PATH;

  return {
    async ensureDirectory(path: string, mode: number): Promise<void> {
      const existing = await lstatOrNull(path);
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          throw new SessionIsolationUnavailableError(
            `디렉터리 경로가 디렉터리가 아닙니다: ${path}`,
          );
        }
        await chmod(path, mode);
        return;
      }
      await mkdir(path, { recursive: true, mode });
      await chmod(path, mode);
    },

    async writeFile(path: string, contents: string, mode: number): Promise<void> {
      const existing = await lstatOrNull(path);
      if (existing?.isSymbolicLink()) {
        throw new SessionIsolationUnavailableError(`쓰기 대상이 symlink입니다: ${path}`);
      }
      const temporary = join(
        dirname(path),
        `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`,
      );
      try {
        await writeFile(temporary, contents, { mode });
        await chmod(temporary, mode);
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },

    async copyFile(source: string, destination: string, mode: number): Promise<void> {
      const existing = await lstatOrNull(destination);
      if (existing?.isSymbolicLink()) {
        throw new SessionIsolationUnavailableError(
          `복사 대상이 symlink입니다: ${destination}`,
        );
      }
      await copyFile(source, destination);
      await chmod(destination, mode);
    },

    async resolveRealPath(path: string): Promise<string> {
      return realpath(path);
    },

    async verifyAuthPreparation(preparation: IsolatedAuthPreparation): Promise<void> {
      switch (preparation.kind) {
        case "codex-grant":
          await verifyCodexGrant({
            canonicalCodexDirectory: preparation.canonicalCodexDirectory,
            homeDirectory: deps.homeDirectory,
            uid: deps.uid,
            codexExecutable: deps.codexExecutable,
            runCommand,
          });
          return;
        case "claude-oauth-token":
          await assertClaudeTokenFile(preparation.claudeTokenFile, deps.uid);
          return;
        case "apikey-env":
          return;
        case "unavailable":
          throw new IsolationAuthUnavailableError("restricted 인증 재료가 없습니다");
        default:
          throw new IsolationAuthUnavailableError("알 수 없는 인증 준비 종류입니다");
      }
    },

    async prepareGitHubCredential(): Promise<Record<string, string>> {
      // env를 넘기지 않아 호스트 프로세스 환경을 그대로 상속한다(gh는 상자 밖 호스트에서
      // 돈다). 기본 runCommand는 env 미지정 시 execFile 기본값 process.env를 쓴다.
      const result = await runCommand("gh", ["auth", "token"], {
        timeoutMs: GH_TIMEOUT_MS,
      });
      const token = result.stdout.trim();
      if (result.exitCode === 0 && token.length > 0) return { GH_TOKEN: token };
      return {};
    },

    async issueRestrictedCredential(sessionId: string): Promise<string> {
      if (sessionId !== deps.sessionId) {
        throw new IsolationPreparationPolicyError(
          "다른 세션의 restricted 자격 증명은 발급하지 않습니다",
        );
      }
      return createRestrictedMcpToken(sessionId, deps.hostBearerToken);
    },

    async sanitizeMcpServers(
      servers: readonly ResolvedMcpServer[],
      policy: IsolationPolicy,
    ): Promise<readonly ResolvedMcpServer[]> {
      const { sanitizedServers } = sanitizeRestrictedMcpServers({
        resolvedServers: servers,
        authenticatedSessionId: deps.sessionId,
        restrictedToken: createRestrictedMcpToken(deps.sessionId, deps.hostBearerToken),
        localMcpPolicy: policy.localMcp,
        actualInternalMcpUrl: deps.actualInternalMcpUrl,
        nodeId: deps.nodeId,
      });
      return sanitizedServers;
    },

    async lstatPath(path: string): Promise<HostPathFact | null> {
      const stats = await lstatOrNull(path);
      return stats === null ? null : toHostPathFact(stats);
    },

    async listDirectory(path: string): Promise<HostDirectoryEntry[]> {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, kind: kindOfDirent(entry) }));
    },

    async readSymlink(path: string): Promise<string | null> {
      try {
        return await readlink(path);
      } catch (error) {
        if (isMissingPathError(error) || (error as NodeJS.ErrnoException).code === "EINVAL") {
          return null;
        }
        throw error;
      }
    },

    async detectWsl(): Promise<boolean> {
      try {
        const osrelease = await readFile(osreleasePath, "utf8");
        return osrelease.toLowerCase().includes("microsoft");
      } catch {
        return false;
      }
    },

    async ensureLockFile(path: string, mode: number): Promise<void> {
      const flags = constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
      let handle: FileHandle;
      try {
        handle = await open(path, flags, mode);
      } catch (error) {
        throw new SessionIsolationUnavailableError(`lock 파일을 열 수 없습니다: ${path}`, error);
      }
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
          throw new SessionIsolationUnavailableError(
            `lock 경로가 일반 파일이 아닙니다: ${path}`,
          );
        }
      } finally {
        await handle.close();
      }
    },

    async ensureSymlink(target: string, path: string): Promise<void> {
      const existing = await lstatOrNull(path);
      if (existing) {
        if (!existing.isSymbolicLink()) {
          throw new SessionIsolationUnavailableError(
            `symlink 자리에 다른 파일이 있습니다: ${path}`,
          );
        }
        const currentTarget = await readlink(path);
        if (currentTarget !== target) {
          throw new SessionIsolationUnavailableError(`symlink 대상이 다릅니다: ${path}`);
        }
        return;
      }
      await symlink(target, path);
    },

    async hashFileSha512(path: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const hash = createHash("sha512");
        const stream = createReadStream(path);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
      });
    },

    async resolveGitCommonDir(repositoryPath: string): Promise<string> {
      const result = await runCommand(
        "git",
        ["-C", repositoryPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        throw new SessionIsolationUnavailableError(
          `git common 디렉터리를 확인할 수 없습니다: ${repositoryPath}`,
        );
      }
      return result.stdout.trim();
    },

    async resolveNodeId(): Promise<string> {
      return deps.nodeId;
    },

    async resolveMainPackageStorePath(): Promise<string | null> {
      if (mainPackageStorePathPromise === null) {
        mainPackageStorePathPromise = (async () => {
          const result = await runCommand("pnpm", ["store", "path"], {
            timeoutMs: PNPM_TIMEOUT_MS,
            cwd: deps.homeDirectory,
          });
          return result.exitCode === 0 ? result.stdout.trim() : null;
        })();
      }
      return mainPackageStorePathPromise;
    },

    async readClaudeOauthToken(): Promise<string> {
      const tokenFile = await assertClaudeTokenFile(deps.claudeTokenFile ?? undefined, deps.uid);
      const token = (await readFile(tokenFile, "utf8")).trim();
      if (token.length === 0) {
        throw new IsolationAuthUnavailableError("Claude OAuth token이 비어 있습니다");
      }
      return token;
    },

    async resolveAgentCommonFilesDirectory(): Promise<string | null> {
      return deps.agentCommonFilesDirectory;
    },

    async resolveServiceEnvironmentDirectory(): Promise<string | null> {
      return deps.serviceEnvironmentDirectory;
    },
  };
}
