import { describe, expect, it, vi } from "vitest";

import {
  CodexExecTurnSummarizer,
  buildCodexExecInvocation,
  parseCodexJsonl,
  type CodexExecProcessPort,
} from "../../src/turn-summary/codex_exec_turn_summarizer.js";

const config = {
  provider: "codex" as const,
  model: "gpt-5.6-terra",
  reasoningEffort: "high" as const,
  timeoutMs: 30_000,
  maxAttempts: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [],
};

describe("buildCodexExecInvocation", () => {
  it("forces ephemeral JSON exec through OAuth-only read-only CLI args", () => {
    const invocation = buildCodexExecInvocation({
      codexPath: "/opt/bin/codex",
      workspaceDir: "/tmp/turn-summary",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      processEnv: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "must-not-leak",
        OPENAI_API_KEY: "must-not-leak",
        TURN_SUMMARY_OPENAI_KEY: "must-not-leak",
        CODEX_API_KEY: "must-not-leak",
      },
    });

    expect(invocation.command).toBe("/opt/bin/codex");
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
      "gpt-5.6-terra",
      "--cd",
      "/tmp/turn-summary",
      "--config",
      'model_reasoning_effort="high"',
      "-",
    ]);
    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(invocation.env.TURN_SUMMARY_OPENAI_KEY).toBeUndefined();
    expect(invocation.env.CODEX_API_KEY).toBeUndefined();
    expect(invocation.env.SCRATCH_WORKSPACE_DIR).toBe("/tmp/turn-summary");
  });
});

describe("parseCodexJsonl", () => {
  it("uses the last completed agent message and only available usage fields", () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "낡은 요약" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "최종 요약" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4, unrelated: 99 },
      }),
    ].join("\n"));

    expect(parsed).toEqual({
      content: "최종 요약",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  });

  it("omits usage when the CLI did not expose token fields", () => {
    expect(parseCodexJsonl(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "요약" },
    }))).toEqual({ content: "요약" });
  });
});

describe("CodexExecTurnSummarizer", () => {
  it("retries once and reports the successful attempt count", async () => {
    const execute = vi
      .fn<CodexExecProcessPort["execute"]>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "성공 요약" },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { output_tokens: 7 },
          }),
        ].join("\n"),
        stderr: "",
      });
    const summarizer = new CodexExecTurnSummarizer({
      codexPath: "/opt/bin/codex",
      processPort: { execute },
      nowMs: (() => {
        let now = 100;
        return () => (now += 25);
      })(),
    });

    await expect(summarizer.summarize({
      userText: "요청",
      assistantText: "결과",
      previousSummaries: [],
    }, config)).resolves.toEqual({
      content: "성공 요약",
      model: "gpt-5.6-terra",
      latencyMs: 25,
      attempts: 2,
      usage: { output_tokens: 7 },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1]).toContain("사용자 메시지");
    expect(execute.mock.calls[0][2]).toBe(30_000);
  });

  it("reports attempts and elapsed latency when all attempts fail", async () => {
    const execute = vi
      .fn<CodexExecProcessPort["execute"]>()
      .mockRejectedValue(new Error("timeout"));
    const summarizer = new CodexExecTurnSummarizer({
      codexPath: "/opt/bin/codex",
      processPort: { execute },
      nowMs: (() => {
        let now = 100;
        return () => (now += 25);
      })(),
    });

    await expect(summarizer.summarize({
      userText: "요청",
      assistantText: "결과",
      previousSummaries: [],
    }, config)).rejects.toMatchObject({
      attempts: 2,
      latencyMs: 25,
    });
  });
});
