import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * resume 턴이 로컬 대화 기록 검사를 통과하도록 CLAUDE_CONFIG_DIR 픽스처를 만든다.
 * 실제 CLI는 띄우지 않지만 어댑터는 spawn 전에 projects/<key>/<sessionId>.jsonl의
 * 존재를 확인하므로, resume을 기대하는 시험은 이 파일을 먼저 만들어야 한다.
 */
export function makeClaudeResumeTranscriptFixture(input: {
  workspaceDir: string;
  sessionIds: readonly string[];
}): string {
  const configDir = mkdtempSync(join(tmpdir(), "claude-resume-transcript-"));
  const directory = join(configDir, "projects", claudeProjectKey(input.workspaceDir));
  mkdirSync(directory, { recursive: true });
  for (const sessionId of input.sessionIds) {
    writeFileSync(join(directory, `${sessionId}.jsonl`), '{"type":"summary"}\n');
  }
  return configDir;
}

export function removeClaudeResumeTranscriptFixture(configDir: string): void {
  rmSync(configDir, { recursive: true, force: true });
}

function claudeProjectKey(workspaceDir: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(workspaceDir);
  } catch {
    // 아직 없는 경로는 어댑터와 같이 resolve 결과를 쓴다.
    resolved = resolve(workspaceDir);
  }
  return resolved.replace(/[^a-zA-Z0-9]/g, "-");
}
