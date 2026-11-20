import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_RESUME_TRANSCRIPT_MISSING_ERROR_CODE,
  claudeResumeTranscriptExists,
} from "../../src/engine/claude_resume_transcript.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claude-resume-transcript-"));
  roots.push(root);
  return root;
}

function projectKey(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

function writeTranscript(
  configDir: string,
  key: string,
  sessionId: string,
  content = '{"type":"summary"}\n',
): string {
  const directory = join(configDir, "projects", key);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${sessionId}.jsonl`);
  writeFileSync(path, content);
  return path;
}

describe("claudeResumeTranscriptExists", () => {
  it("워크스페이스 경로를 CLI project key로 바꾼 로컬 JSONL을 찾는다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "a b", "c");
    mkdirSync(workspaceDir, { recursive: true });
    const configDir = join(root, "config");
    const key = projectKey(realpathSync(workspaceDir));
    expect(key.endsWith("-a-b-c")).toBe(true);
    writeTranscript(configDir, key, "session-1");

    await expect(claudeResumeTranscriptExists({
      env: { CLAUDE_CONFIG_DIR: configDir },
      workspaceDir,
      sessionId: "session-1",
    })).resolves.toBe(true);
  });

  it("심링크 워크스페이스는 realpath 기준 key로 찾는다", async () => {
    const root = makeRoot();
    const realWorkspace = join(root, "real-workspace");
    mkdirSync(realWorkspace);
    const linkedWorkspace = join(root, "linked-workspace");
    symlinkSync(realWorkspace, linkedWorkspace, "dir");
    const configDir = join(root, "config");
    writeTranscript(configDir, projectKey(realpathSync(realWorkspace)), "session-link");

    await expect(claudeResumeTranscriptExists({
      env: { CLAUDE_CONFIG_DIR: configDir },
      workspaceDir: linkedWorkspace,
      sessionId: "session-link",
    })).resolves.toBe(true);
  });

  it("크기가 0인 JSONL은 없는 것으로 본다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    const configDir = join(root, "config");
    writeTranscript(configDir, projectKey(realpathSync(workspaceDir)), "session-empty", "");

    await expect(claudeResumeTranscriptExists({
      env: { CLAUDE_CONFIG_DIR: configDir },
      workspaceDir,
      sessionId: "session-empty",
    })).resolves.toBe(false);
  });

  it("projects 폴더가 없으면 false다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);

    await expect(claudeResumeTranscriptExists({
      env: { CLAUDE_CONFIG_DIR: join(root, "missing-config") },
      workspaceDir,
      sessionId: "session-missing",
    })).resolves.toBe(false);
  });

  it("CLAUDE_CONFIG_DIR이 없으면 HOME 아래 .claude를 설정 루트로 쓴다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    writeTranscript(join(root, ".claude"), projectKey(realpathSync(workspaceDir)), "session-home");

    await expect(claudeResumeTranscriptExists({
      env: { HOME: root },
      workspaceDir,
      sessionId: "session-home",
    })).resolves.toBe(true);
  });

  it("200자를 넘는 key는 앞 200자- 접두 폴더에서 찾는다", async () => {
    const root = makeRoot();
    // 디렉터리를 만들지 않는 긴 경로다. realpath가 실패하면 resolve 값으로 key를 만든다.
    const workspaceDir = `/${"a".repeat(250)}`;
    const key = projectKey(workspaceDir);
    expect(key.length).toBeGreaterThan(200);
    const configDir = join(root, "config");
    writeTranscript(configDir, `${key.slice(0, 200)}-hashed`, "session-long");

    await expect(claudeResumeTranscriptExists({
      env: { CLAUDE_CONFIG_DIR: configDir },
      workspaceDir,
      sessionId: "session-long",
    })).resolves.toBe(true);
    await expect(claudeResumeTranscriptExists({
      env: { CLAUDE_CONFIG_DIR: configDir },
      workspaceDir,
      sessionId: "session-other",
    })).resolves.toBe(false);
  });

  it("ENOENT가 아닌 조회 오류는 던진다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    const configDir = join(root, "config");
    const key = projectKey(realpathSync(workspaceDir));
    mkdirSync(join(configDir, "projects"), { recursive: true });
    writeFileSync(join(configDir, "projects", key), "not a directory");

    await expect(claudeResumeTranscriptExists({
      env: { CLAUDE_CONFIG_DIR: configDir },
      workspaceDir,
      sessionId: "session-1",
    })).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("없음 안내는 wire error_code 상수 하나를 쓴다", () => {
    expect(CLAUDE_RESUME_TRANSCRIPT_MISSING_ERROR_CODE).toBe("claude_resume_transcript_missing");
  });
});
