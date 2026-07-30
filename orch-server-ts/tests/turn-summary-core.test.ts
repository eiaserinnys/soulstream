import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexExecInvocation,
  CodexExecTurnSummarizer,
  parseCodexJsonl,
} from "../src/turn-summary/codex_exec_turn_summarizer.js";
import { resolveCodexCliPath } from
  "../src/turn-summary/codex_cli_path.js";
import {
  OpenAiApiTurnSummarizer,
} from "../src/turn-summary/openai_api_turn_summarizer.js";
import {
  buildTurnSummaryPrompt,
  truncateCodepoints,
} from "../src/turn-summary/turn_summarizer.js";
import {
  TurnSummaryConfigService,
  type TurnSummaryConfig,
} from "../src/turn-summary/turn_summary_config.js";
import {
  findBlockedChildProcessEnvKeys,
  sanitizeChildProcessEnv,
} from "../src/runtime/child_process_env.js";

const CONFIG: TurnSummaryConfig = {
  enabled: true,
  instruction:
    "①사용자가 요청한 것 ②에이전트가 한 일 ③결과를 한국어 1~3줄로 요약하라. 원문에 없는 사실을 만들지 말 것.",
  storyInstruction: "마커를 붙인 narrative와 highlight를 JSON으로 반환하라.",
  storyFoldThreshold: 10,
  storyFoldBatchSize: 5,
  storyNarrativeMaxChars: 1_500,
  provider: "codex",
  model: "gpt-5.6-terra",
  reasoningEffort: "high",
  timeoutMs: 30_000,
  maxAttempts: 2,
  codexConcurrencyLimit: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [
    "055be5a6-1285-48aa-a8a1-59e40fbe59af",
    "9e7baafe-387f-4404-8349-ec994597f4cf",
  ],
};

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("turn summary prompt", () => {
  it("truncates on Unicode codepoint boundaries", () => {
    expect(truncateCodepoints("가😀나다", 3)).toBe("가😀나");
  });

  it("uses the configured instruction and the latest rolling summaries", () => {
    const prompt = buildTurnSummaryPrompt({
      userText: "요청",
      assistantText: "결과",
      previousSummaries: ["1", "2", "3", "4", "5", "6"],
    }, CONFIG);

    expect(prompt).toContain(CONFIG.instruction);
    expect(prompt).not.toContain("\n1. 1\n");
    expect(prompt).toContain("\n1. 2\n");
    expect(prompt).toContain("\n5. 6\n");
    expect(prompt).toContain("[사용자 메시지]\n요청");
    expect(prompt).toContain("[에이전트 최종 응답]\n결과");
  });
});

describe("TurnSummaryConfigService", () => {
  it("uses the disabled repository default when no local overlay exists", () => {
    const path = fileURLToPath(
      new URL("../config/turn-summary.yaml", import.meta.url),
    );
    const service = new TurnSummaryConfigService(path, {
      warn: vi.fn(),
    });

    expect(service.read()).toMatchObject({
      enabled: false,
      provider: "codex",
      model: "gpt-5.6-terra",
      codexConcurrencyLimit: 2,
      storyFoldThreshold: 10,
      storyFoldBatchSize: 5,
      storyNarrativeMaxChars: 1_500,
    });
    const instruction = service.read().storyInstruction;
    expect(instruction).toContain("[T12]");
    expect(instruction).toContain("[T12-T15]");
    expect(instruction).toContain(
      "모델 선정·정책·보안 관련 결정은 연령과 무관하게 보존",
    );
    expect(instruction).toContain(
      "결정이 번복된 경우 번복 이력을 시간 순서대로 남긴다",
    );
  });

  it("shallow merges a partial local overlay over the repository config", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-summary-config-"));
    tempDirs.push(dir);
    const path = join(dir, "turn-summary.yaml");
    const service = new TurnSummaryConfigService(path, {
      warn: vi.fn(),
    });

    writeFileSync(path, yamlConfig("gpt-5.6-terra", false), "utf8");
    writeFileSync(
      join(dir, "turn-summary.local.yaml"),
      "enabled: true\nmodel: gpt-5.4-mini\nstory_fold_threshold: 12\n",
      "utf8",
    );

    expect(service.read()).toMatchObject({
      enabled: true,
      provider: "codex",
      model: "gpt-5.4-mini",
      codexConcurrencyLimit: 2,
      storyFoldThreshold: 12,
    });
  });

  it("keeps the last good merged config after an invalid local overlay", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-summary-config-"));
    tempDirs.push(dir);
    const path = join(dir, "turn-summary.yaml");
    const localPath = join(dir, "turn-summary.local.yaml");
    const warnings: unknown[] = [];
    const service = new TurnSummaryConfigService(path, {
      warn: (...args) => warnings.push(args),
    });

    writeFileSync(path, yamlConfig("gpt-5.6-terra", false), "utf8");
    writeFileSync(localPath, "enabled: true\n", "utf8");
    expect(service.read().enabled).toBe(true);

    writeFileSync(localPath, "unexpected_key: true\n", "utf8");
    expect(service.read().enabled).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("hot reloads valid config and keeps the last good value after an invalid update", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-summary-config-"));
    tempDirs.push(dir);
    const path = join(dir, "turn-summary.yaml");
    const warnings: unknown[] = [];
    const service = new TurnSummaryConfigService(path, {
      warn: (...args) => warnings.push(args),
    });

    writeFileSync(path, yamlConfig("gpt-5.6-terra", false), "utf8");
    expect(service.read().enabled).toBe(false);

    writeFileSync(path, yamlConfig("gpt-5.6-terra", true), "utf8");
    expect(service.read().enabled).toBe(true);
    expect(service.read().model).toBe("gpt-5.6-terra");

    writeFileSync(path, yamlConfig("gpt-5.4-mini", true), "utf8");
    expect(service.read().model).toBe("gpt-5.4-mini");

    writeFileSync(path, "provider: invalid", "utf8");
    expect(service.read().model).toBe("gpt-5.4-mini");
    expect(warnings).toHaveLength(1);
  });
});

describe("turn summary child process env", () => {
  it("removes every billing-switch key and preserves OAuth discovery variables", () => {
    const env = sanitizeChildProcessEnv({
      HOME: "/oauth-home",
      CODEX_HOME: "/codex-home",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "anthropic",
      OPENAI_API_KEY: "openai",
      TURN_SUMMARY_OPENAI_KEY: "summary",
    });

    expect(env).toEqual({
      HOME: "/oauth-home",
      CODEX_HOME: "/codex-home",
      PATH: "/bin",
    });
    expect(findBlockedChildProcessEnvKeys({
      OPENAI_API_KEY: "",
      TURN_SUMMARY_OPENAI_KEY: "x",
    })).toEqual(["OPENAI_API_KEY", "TURN_SUMMARY_OPENAI_KEY"]);
  });
});

describe("Codex turn summary provider", () => {
  it("resolves the supervisor-safe HOME install when PATH is narrow", () => {
    const home = mkdtempSync(join(tmpdir(), "turn-summary-codex-home-"));
    tempDirs.push(home);
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const codexPath = join(bin, "codex");
    writeFileSync(codexPath, "#!/bin/sh\n", "utf8");
    chmodSync(codexPath, 0o755);

    expect(resolveCodexCliPath({
      HOME: home,
      PATH: join(home, "supervisor-bin"),
    })).toEqual({
      path: codexPath,
      source: "HOME_LOCAL_BIN",
    });
  });

  it("always builds an ephemeral JSON OAuth invocation", () => {
    const invocation = buildCodexExecInvocation({
      codexPath: "codex",
      workspaceDir: "/tmp/summary",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      processEnv: {
        HOME: "/oauth-home",
        OPENAI_API_KEY: "must-not-leak",
        TURN_SUMMARY_OPENAI_KEY: "must-not-leak",
      },
    });

    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual([
      "exec",
      "--ephemeral",
      "--json",
      "--ignore-rules",
      "--ignore-user-config",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4-mini",
      "--cd",
      "/tmp/summary",
      "--config",
      'model_reasoning_effort="high"',
      "-",
    ]);
    expect(invocation.env.HOME).toBe("/oauth-home");
    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.TURN_SUMMARY_OPENAI_KEY).toBeUndefined();
  });

  it("parses the last assistant item and only available usage fields", () => {
    expect(parseCodexJsonl([
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "첫 답" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "최종 요약" },
      }),
    ].join("\n"))).toEqual({
      content: "최종 요약",
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });

  it("retries once without reusing a session workspace", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "성공" },
        }),
        stderr: "",
      });
    const summarizer = new CodexExecTurnSummarizer({
      codexPath: "codex",
      processPort: { execute },
      processEnv: { HOME: "/oauth-home" },
      nowMs: vi.fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(110)
        .mockReturnValueOnce(130)
        .mockReturnValueOnce(140)
        .mockReturnValueOnce(170),
    });

    await expect(summarizer.summarize({
      userText: "요청",
      assistantText: "응답",
      previousSummaries: [],
    }, CONFIG)).resolves.toMatchObject({
      content: "성공",
      attempts: 2,
      latencyMs: 70,
      spawnDurationMs: 50,
      peakConcurrentSpawns: 1,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0].cwd).not.toBe(execute.mock.calls[1]?.[0].cwd);
  });

  it("passes a structured output schema to the same ephemeral Codex execution path", async () => {
    let schema: unknown;
    const execute = vi.fn(async (invocation) => {
      const flagIndex = invocation.args.indexOf("--output-schema");
      const schemaPath = invocation.args[flagIndex + 1];
      schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      return {
        stdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "{\"narrative\":\"[T1] 시작했다.\",\"highlight\":\"핵심\"}",
          },
        }),
        stderr: "",
      };
    });
    const summarizer = new CodexExecTurnSummarizer({
      codexPath: "codex",
      processPort: { execute },
      processEnv: { HOME: "/oauth-home" },
    });

    await summarizer.generate("스토리", CONFIG, {
      maxAttempts: 1,
      outputSchema: {
        type: "object",
        required: ["narrative", "highlight"],
      },
    });

    expect(schema).toEqual({
      type: "object",
      required: ["narrative", "highlight"],
    });
    expect(execute.mock.calls[0]?.[0].args).toContain("--ephemeral");
  });

  it("shares one spawn limiter between turn summaries and story folds", async () => {
    const oneAtATime = { ...CONFIG, codexConcurrencyLimit: 1 };
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const execute = vi.fn(async () =>
      await new Promise<{ stdout: string; stderr: string }>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releases.push(() => {
          active -= 1;
          resolve({
            stdout: JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "완료" },
            }),
            stderr: "",
          });
        });
      })
    );
    const summarizer = new CodexExecTurnSummarizer({
      codexPath: "codex",
      processPort: { execute },
      processEnv: { HOME: "/oauth-home" },
    });

    const turn = summarizer.summarize({
      userText: "요청",
      assistantText: "응답",
      previousSummaries: [],
    }, oneAtATime);
    const story = summarizer.generate("스토리", oneAtATime, {
      maxAttempts: 1,
    });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(1);
    releases.shift()?.();
    await Promise.all([turn, story]);
  });

  it("queues bursts above the configured global spawn limit", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const execute = vi.fn(async () =>
      await new Promise<{ stdout: string; stderr: string }>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releases.push(() => {
          active -= 1;
          resolve({
            stdout: JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "요약" },
            }),
            stderr: "",
          });
        });
      })
    );
    const summarizer = new CodexExecTurnSummarizer({
      codexPath: "codex",
      processPort: { execute },
      processEnv: { HOME: "/oauth-home" },
    });

    const calls = Array.from({ length: 3 }, () =>
      summarizer.summarize({
        userText: "요청",
        assistantText: "응답",
        previousSummaries: [],
      }, CONFIG)
    );

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(active).toBe(2);
    releases.shift()?.();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(maxActive).toBe(2);
    releases.splice(0).forEach((release) => release());

    const results = await Promise.all(calls);
    expect(
      results.every(
        (result) =>
          (result.peakConcurrentSpawns ?? 0) >= 1 &&
          (result.peakConcurrentSpawns ?? 0) <= 2,
      ),
    ).toBe(true);
    expect(
      Math.max(...results.map((result) => result.peakConcurrentSpawns ?? 0)),
    ).toBe(2);
  });
});

describe("OpenAI API turn summary provider", () => {
  it("uses chat.completions with the configured model, temperature zero, and no SDK retries", async () => {
    const execute = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "API 요약" } }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    });
    const summarizer = new OpenAiApiTurnSummarizer({
      client: { execute },
      nowMs: vi.fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(130),
    });

    const apiConfig = {
      ...CONFIG,
      provider: "openai-api" as const,
      model: "gpt-5.4-mini-test",
    };
    await expect(summarizer.summarize({
      userText: "요청",
      assistantText: "응답",
      previousSummaries: [],
    }, apiConfig)).resolves.toEqual({
      content: "API 요약",
      model: "gpt-5.4-mini-test",
      latencyMs: 30,
      attempts: 1,
      usage: {
        input_tokens: 20,
        cached_input_tokens: 5,
        output_tokens: 4,
      },
    });
    expect(execute).toHaveBeenCalledWith({
      model: "gpt-5.4-mini-test",
      temperature: 0,
      messages: [{ role: "user", content: expect.any(String) }],
    }, {
      timeout: 30_000,
      maxRetries: 0,
    });
  });
});

function yamlConfig(model: string, enabled: boolean): string {
  return [
    `enabled: ${enabled}`,
    `instruction: "${CONFIG.instruction}"`,
    `story_instruction: "${CONFIG.storyInstruction}"`,
    `story_fold_threshold: ${CONFIG.storyFoldThreshold}`,
    `story_fold_batch_size: ${CONFIG.storyFoldBatchSize}`,
    `story_narrative_max_chars: ${CONFIG.storyNarrativeMaxChars}`,
    "provider: codex",
    `model: ${model}`,
    "reasoning_effort: high",
    "timeout_ms: 30000",
    "max_attempts: 2",
    "codex_concurrency_limit: 2",
    "codepoint_limit: 6000",
    "history_limit: 5",
    "excluded_folder_ids:",
    ...CONFIG.excludedFolderIds.map((id) => `  - ${id}`),
    "",
  ].join("\n");
}
