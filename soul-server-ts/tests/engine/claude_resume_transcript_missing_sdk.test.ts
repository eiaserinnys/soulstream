import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeEngineAdapter } from "../../src/engine/claude_adapter.js";
import { CLAUDE_RESUME_TRANSCRIPT_MISSING_ERROR_CODE } from
  "../../src/engine/claude_resume_transcript.js";
import { ClaudeSdkClient } from "../../src/engine/claude_sdk_client.js";
import type { EngineExecuteParams, SSEEventPayload } from "../../src/engine/protocol.js";

const silentLogger = pino({ level: "silent" });
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claude-resume-transcript-sdk-"));
  roots.push(root);
  return root;
}

function projectKey(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

function writeTranscript(configDir: string, key: string, sessionId: string): void {
  const directory = join(configDir, "projects", key);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${sessionId}.jsonl`), '{"type":"summary"}\n');
}

/** 실제 SDK가 띄우는 CLI 자리에 놓는 stub. argv만 남기고 종료한다. */
function writeCaptureCli(root: string): { executablePath: string; capturePath: string } {
  const executablePath = join(root, "capture-claude");
  const capturePath = join(root, "spawn-argv.json");
  writeFileSync(executablePath, [
    "#!/usr/bin/env node",
    'const { writeFileSync } = require("node:fs");',
    "writeFileSync(process.env.CAPTURE_CLI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
    "process.exit(0);",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executablePath, 0o700);
  return { executablePath, capturePath };
}

function captureEnv(input: {
  configDir: string;
  executablePath: string;
  capturePath: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: input.configDir,
    CLAUDE_CODE_EXECPATH: input.executablePath,
    CAPTURE_CLI_ARGV_FILE: input.capturePath,
    ...input.extra,
  };
}

async function collectEvents(
  engine: ClaudeEngineAdapter,
  params: EngineExecuteParams,
): Promise<SSEEventPayload[]> {
  const events: SSEEventPayload[] = [];
  try {
    for await (const event of engine.execute(params)) events.push(event);
  } catch {
    // stub CLI는 Claude stream protocol을 말하지 않는다.
  }
  return events;
}

function readCapturedArgv(capturePath: string): string[] {
  return JSON.parse(readFileSync(capturePath, "utf8")) as string[];
}

function resumeTarget(argv: string[]): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length);
  }
  const index = argv.indexOf("--resume");
  return index === -1 ? undefined : argv[index + 1];
}

function missingTranscriptEvents(events: SSEEventPayload[]): SSEEventPayload[] {
  return events.filter((event) => {
    const record = event as Record<string, unknown>;
    return record.error_code === CLAUDE_RESUME_TRANSCRIPT_MISSING_ERROR_CODE;
  });
}

describe("Claude adapter resume transcript detection", () => {
  it("로컬 JSONL이 있으면 실제 SDK가 --resume로 띄운다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    const configDir = join(root, "config");
    const sessionId = "550e8400-e29b-41d4-a716-446655440001";
    writeTranscript(configDir, projectKey(realpathSync(workspaceDir)), sessionId);
    const { executablePath, capturePath } = writeCaptureCli(root);
    const client = new ClaudeSdkClient({ postResultDrainMs: 10 }, silentLogger);
    const engine = new ClaudeEngineAdapter({
      workspaceDir,
      client,
      processEnv: captureEnv({ configDir, executablePath, capturePath }),
    }, silentLogger);

    try {
      const events = await collectEvents(engine, {
        prompt: "resume this session",
        resumeSessionId: sessionId,
      });

      expect(existsSync(capturePath)).toBe(true);
      expect(resumeTarget(readCapturedArgv(capturePath))).toBe(sessionId);
      expect(missingTranscriptEvents(events)).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it("로컬 JSONL이 없으면 CLI를 띄우지 않고 비치명 안내 이벤트만 낸다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    const configDir = join(root, "config");
    const sessionId = "550e8400-e29b-41d4-a716-446655440002";
    const { executablePath, capturePath } = writeCaptureCli(root);
    const client = new ClaudeSdkClient({ postResultDrainMs: 10 }, silentLogger);
    const engine = new ClaudeEngineAdapter({
      workspaceDir,
      client,
      processEnv: captureEnv({ configDir, executablePath, capturePath }),
    }, silentLogger);

    try {
      const events = await collectEvents(engine, {
        prompt: "resume this session",
        resumeSessionId: sessionId,
      });

      expect(existsSync(capturePath)).toBe(false);
      const missing = missingTranscriptEvents(events);
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({
        type: "error",
        fatal: false,
        error_code: CLAUDE_RESUME_TRANSCRIPT_MISSING_ERROR_CODE,
      });
      expect((missing[0] as { message?: string }).message).toContain("이전 Claude 대화 기록 파일이 없어");
    } finally {
      await engine.close();
    }
  });

  it("계정 풀 resume은 선택 프로필의 공유 projects에서 JSONL을 찾고 --resume한다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    const sharedProjects = join(root, "shared-projects");
    mkdirSync(sharedProjects);
    const profileConfigDir = join(root, "profile-a");
    mkdirSync(profileConfigDir);
    symlinkSync(sharedProjects, join(profileConfigDir, "projects"), "dir");
    const sessionId = "550e8400-e29b-41d4-a716-446655440003";
    writeTranscript(profileConfigDir, projectKey(realpathSync(workspaceDir)), sessionId);
    const { executablePath, capturePath } = writeCaptureCli(root);
    const client = new ClaudeSdkClient({ postResultDrainMs: 10 }, silentLogger);
    const accountTurnPort = makeAccountTurnPort(profileConfigDir);
    const engine = new ClaudeEngineAdapter({
      workspaceDir,
      client,
      processEnv: captureEnv({ configDir: profileConfigDir, executablePath, capturePath }),
      claudeAccountPoolEnabled: true,
      claudeAccountTurnPort: accountTurnPort,
      claudeAccountTurnState: makeAccountTurnState(),
      persistentSessionRegistry: makeRegistry(client),
    }, silentLogger);

    try {
      const events = await collectEvents(engine, {
        agentSessionId: "agent-session-pool-resume",
        prompt: "resume under the pool",
        inputUuid: "turn-pool-resume",
        model: "claude-sonnet-4.5",
        claudeAccountPoolTarget: true,
        resumeSessionId: sessionId,
      });

      expect(existsSync(capturePath)).toBe(true);
      expect(resumeTarget(readCapturedArgv(capturePath))).toBe(sessionId);
      expect(missingTranscriptEvents(events)).toEqual([]);
      expect(accountTurnPort.release).toHaveBeenCalledTimes(1);
      expect(accountTurnPort.release).toHaveBeenCalledWith(expect.objectContaining({
        session_id: "agent-session-pool-resume",
        account_id: "account-a",
      }));
    } finally {
      await engine.close();
    }
  });

  it("계정 풀에서 JSONL이 없으면 spawn 없이 안내 이벤트를 내고 점유를 푼다", async () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    const sharedProjects = join(root, "shared-projects");
    mkdirSync(sharedProjects);
    const profileConfigDir = join(root, "profile-a");
    mkdirSync(profileConfigDir);
    symlinkSync(sharedProjects, join(profileConfigDir, "projects"), "dir");
    const { executablePath, capturePath } = writeCaptureCli(root);
    const client = new ClaudeSdkClient({ postResultDrainMs: 10 }, silentLogger);
    const accountTurnPort = makeAccountTurnPort(profileConfigDir);
    const engine = new ClaudeEngineAdapter({
      workspaceDir,
      client,
      processEnv: captureEnv({ configDir: profileConfigDir, executablePath, capturePath }),
      claudeAccountPoolEnabled: true,
      claudeAccountTurnPort: accountTurnPort,
      claudeAccountTurnState: makeAccountTurnState(),
      persistentSessionRegistry: makeRegistry(client),
    }, silentLogger);

    try {
      const events = await collectEvents(engine, {
        agentSessionId: "agent-session-pool-missing",
        prompt: "resume under the pool",
        inputUuid: "turn-pool-missing",
        model: "claude-sonnet-4.5",
        claudeAccountPoolTarget: true,
        resumeSessionId: "550e8400-e29b-41d4-a716-446655440004",
      });

      expect(existsSync(capturePath)).toBe(false);
      expect(missingTranscriptEvents(events)).toHaveLength(1);
      expect(accountTurnPort.release).toHaveBeenCalledTimes(1);
      expect(accountTurnPort.release).toHaveBeenCalledWith(expect.objectContaining({
        session_id: "agent-session-pool-missing",
        account_id: "account-a",
      }));
    } finally {
      await engine.close();
    }
  });
});

function makeAccountTurnPort(configDir: string) {
  return {
    select: vi.fn().mockResolvedValue({
      account_id: "account-a",
      config_dir: configDir,
      available_count: 1,
    }),
    reject: vi.fn(),
    reportAuthFailure: vi.fn(async () => undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAccountTurnState() {
  return {
    read: () => null,
    write: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRegistry(client: ClaudeSdkClient) {
  return {
    acquire: () => client,
    close: vi.fn().mockResolvedValue(true),
    release: vi.fn(),
    reserve: vi.fn(),
  };
}
