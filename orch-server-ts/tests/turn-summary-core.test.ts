import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
  provider: "codex",
  model: "gpt-5.6-terra",
  reasoningEffort: "high",
  timeoutMs: 30_000,
  maxAttempts: 2,
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
  it("ships with summary generation and emission disabled", () => {
    const path = fileURLToPath(
      new URL("../config/turn-summary.yaml", import.meta.url),
    );
    const service = new TurnSummaryConfigService(path, {
      warn: vi.fn(),
    });

    expect(service.read()).toMatchObject({
      enabled: false,
      provider: "openai-api",
      model: "gpt-5.4-mini",
    });
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
        .mockReturnValueOnce(150),
    });

    await expect(summarizer.summarize({
      userText: "요청",
      assistantText: "응답",
      previousSummaries: [],
    }, CONFIG)).resolves.toMatchObject({
      content: "성공",
      attempts: 2,
      latencyMs: 50,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0].cwd).not.toBe(execute.mock.calls[1]?.[0].cwd);
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
    "provider: codex",
    `model: ${model}`,
    "reasoning_effort: high",
    "timeout_ms: 30000",
    "max_attempts: 2",
    "codepoint_limit: 6000",
    "history_limit: 5",
    "excluded_folder_ids:",
    ...CONFIG.excludedFolderIds.map((id) => `  - ${id}`),
    "",
  ].join("\n");
}
