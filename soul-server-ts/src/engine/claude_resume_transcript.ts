import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** resume할 로컬 대화 기록이 없어 백엔드 세션을 새로 시작할 때 내는 비치명 error code. */
export const CLAUDE_RESUME_TRANSCRIPT_MISSING_ERROR_CODE = "claude_resume_transcript_missing";

const CLAUDE_PROJECT_KEY_MAX_LENGTH = 200;

/**
 * Claude CLI가 `--resume <sessionId>`로 읽을 로컬 대화 기록(JSONL)이 있는지 본다.
 *
 * 프로젝트 폴더 이름은 CLI와 같은 규칙이다: 실제 cwd의 영숫자가 아닌 글자를 `-`로
 * 바꾸고, 200자를 넘으면 앞 200자 + `-` + 해시를 쓴다. 그때는 접두로 시작하는
 * 폴더를 모두 본다. 설정 루트도 자식 env와 같은 `CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)다.
 */
export async function claudeResumeTranscriptExists(input: {
  env: Record<string, string | undefined>;
  workspaceDir: string;
  sessionId: string;
}): Promise<boolean> {
  const configRoot = input.env.CLAUDE_CONFIG_DIR
    ?? join(input.env.HOME ?? homedir(), ".claude");
  const projectsDir = join(configRoot, "projects");
  const key = (await resolveRealPath(input.workspaceDir)).replace(/[^a-zA-Z0-9]/g, "-");
  const fileName = `${input.sessionId}.jsonl`;
  if (key.length <= CLAUDE_PROJECT_KEY_MAX_LENGTH) {
    return await isNonEmptyFile(join(projectsDir, key, fileName));
  }
  const prefix = `${key.slice(0, CLAUDE_PROJECT_KEY_MAX_LENGTH)}-`;
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    if (await isNonEmptyFile(join(projectsDir, entry.name, fileName))) return true;
  }
  return false;
}

async function resolveRealPath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object"
    && err !== null
    && (err as NodeJS.ErrnoException).code === "ENOENT";
}
