import { type Dirent, type Stats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { IsolationAuthUnavailableError } from "./session_filesystem_errors.js";

/**
 * restricted 인증 재료의 정적 검사. 토큰 원문·인증 파일 내용은 읽지 않으며,
 * 오류 메시지에도 값을 넣지 않는다.
 */

const CODEX_ALLOWED_TEMP_PREFIX = ".auth-";
const CODEX_SESSION_FILE = "auth.json";
const CODEX_LOCK_FILE = "auth.lock";
const CODEX_CLI_VERSION_PATTERN = /^codex-cli (\S+)$/;
const CODEX_VERSION_TIMEOUT_MS = 20_000;

/** restricted Codex writer로 확인한 codex-cli 판. */
export const VERIFIED_CODEX_WRITER_VERSIONS: readonly string[] = ["0.167.0"];

export type CodexVersionCommand = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string }>;

export interface CodexGrantFacts {
  canonicalCodexDirectory: string | undefined;
  homeDirectory: string;
  uid: number;
  codexExecutable: string | null;
  runCommand: CodexVersionCommand;
}

async function statForAuth(path: string, label: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    throw new IsolationAuthUnavailableError(`${label}을 확인할 수 없습니다`, error);
  }
}

/** claude-oauth-token 파일의 정적 조건. 내용은 읽지 않는다. */
export async function assertClaudeTokenFile(
  path: string | undefined,
  uid: number,
): Promise<string> {
  if (!path) {
    throw new IsolationAuthUnavailableError("Claude token 파일이 준비되지 않았습니다");
  }
  if (!isAbsolute(path)) {
    throw new IsolationAuthUnavailableError("Claude token 경로가 절대 경로가 아닙니다");
  }
  const stats = await statForAuth(path, "Claude token 파일");
  if (!stats.isFile()) {
    throw new IsolationAuthUnavailableError("Claude token이 일반 파일이 아닙니다");
  }
  if (stats.uid !== uid) {
    throw new IsolationAuthUnavailableError("Claude token 파일 소유자가 다릅니다");
  }
  if (stats.nlink !== 1) {
    throw new IsolationAuthUnavailableError(
      "Claude token 파일이 다른 경로와 inode를 공유합니다",
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new IsolationAuthUnavailableError("Claude token 파일 권한이 너무 넓습니다");
  }
  return path;
}

/** canonical Codex 디렉터리 항목은 auth.json, auth.lock, `.auth-*` 일반 파일만 허용한다. */
async function assertCodexDirectoryEntries(canonicalDirectory: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(canonicalDirectory, { withFileTypes: true });
  } catch (error) {
    throw new IsolationAuthUnavailableError("canonical Codex 디렉터리를 읽을 수 없습니다", error);
  }
  let hasAuthJson = false;
  for (const entry of entries) {
    if (entry.name === CODEX_SESSION_FILE) {
      hasAuthJson = true;
      continue;
    }
    if (entry.name === CODEX_LOCK_FILE || entry.name.startsWith(CODEX_ALLOWED_TEMP_PREFIX)) {
      if (!entry.isFile()) {
        throw new IsolationAuthUnavailableError(
          `canonical Codex 디렉터리에 일반 파일이 아닌 항목이 있습니다: ${entry.name}`,
        );
      }
      continue;
    }
    throw new IsolationAuthUnavailableError(
      `canonical Codex 디렉터리에 허용되지 않은 항목이 있습니다: ${entry.name}`,
    );
  }
  if (!hasAuthJson) {
    throw new IsolationAuthUnavailableError("canonical Codex 디렉터리에 auth.json이 없습니다");
  }
}

async function assertCodexWriterVersion(
  codexExecutable: string,
  runCommand: CodexVersionCommand,
): Promise<void> {
  const result = await runCommand(codexExecutable, ["--version"], {
    timeoutMs: CODEX_VERSION_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new IsolationAuthUnavailableError("codex 실행 파일의 판을 확인할 수 없습니다");
  }
  const version = CODEX_CLI_VERSION_PATTERN.exec(result.stdout.trim())?.[1];
  if (version === undefined || !VERIFIED_CODEX_WRITER_VERSIONS.includes(version)) {
    throw new IsolationAuthUnavailableError("확인되지 않은 codex-cli 판입니다");
  }
}

/** codex-grant 준비가 실제 파일 배치와 writer 판에서 성립하는지 확인한다. */
export async function verifyCodexGrant(facts: CodexGrantFacts): Promise<void> {
  const canonicalDirectory = facts.canonicalCodexDirectory;
  if (!canonicalDirectory) {
    throw new IsolationAuthUnavailableError("canonical Codex 인증 디렉터리가 준비되지 않았습니다");
  }
  const directoryStats = await statForAuth(canonicalDirectory, "canonical Codex 인증 디렉터리");
  if (!directoryStats.isDirectory()) {
    throw new IsolationAuthUnavailableError(
      "canonical Codex 인증 디렉터리가 디렉터리가 아닙니다",
    );
  }
  if (directoryStats.uid !== facts.uid) {
    throw new IsolationAuthUnavailableError("canonical Codex 인증 디렉터리 소유자가 다릅니다");
  }
  if ((directoryStats.mode & 0o777) !== 0o700) {
    throw new IsolationAuthUnavailableError(
      "canonical Codex 인증 디렉터리 권한이 0700이 아닙니다",
    );
  }

  const authJsonStats = await statForAuth(
    join(canonicalDirectory, CODEX_SESSION_FILE),
    "canonical Codex auth.json",
  );
  if (!authJsonStats.isFile()) {
    throw new IsolationAuthUnavailableError("canonical Codex auth.json이 일반 파일이 아닙니다");
  }
  if (authJsonStats.nlink !== 1) {
    throw new IsolationAuthUnavailableError(
      "canonical Codex auth.json이 다른 경로와 inode를 공유합니다",
    );
  }
  if ((authJsonStats.mode & 0o777) !== 0o600) {
    throw new IsolationAuthUnavailableError("canonical Codex auth.json 권한이 0600이 아닙니다");
  }

  await assertCodexDirectoryEntries(canonicalDirectory);

  const originalAuthJson = join(facts.homeDirectory, ".codex", CODEX_SESSION_FILE);
  const originalStats = await statForAuth(originalAuthJson, "Codex auth.json 원래 위치");
  if (!originalStats.isSymbolicLink()) {
    throw new IsolationAuthUnavailableError("Codex auth.json 원래 위치가 symlink가 아닙니다");
  }
  let linkTarget: string;
  try {
    linkTarget = await readlink(originalAuthJson);
  } catch (error) {
    throw new IsolationAuthUnavailableError("Codex auth.json symlink를 읽을 수 없습니다", error);
  }
  if (linkTarget !== join(canonicalDirectory, CODEX_SESSION_FILE)) {
    throw new IsolationAuthUnavailableError(
      "Codex auth.json symlink가 canonical 파일을 가리키지 않습니다",
    );
  }

  if (!facts.codexExecutable) {
    throw new IsolationAuthUnavailableError("codex 실행 파일 경로가 준비되지 않았습니다");
  }
  await assertCodexWriterVersion(facts.codexExecutable, facts.runCommand);
}
