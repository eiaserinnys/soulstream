import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ClaudeEphemeralExecutor } from "../src/llm/claude_ephemeral_executor.js";

const root = mkdtempSync(join(tmpdir(), "claude-ephemeral-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HOST_HOME = "/host-home-that-must-not-be-used";

function fakeClaude(name: string, body: string): { path: string; record: string } {
  const record = join(root, `${name}.json`);
  const path = join(root, `${name}.sh`);
  writeFileSync(path, [
    "#!/bin/sh",
    `cat > "${record}.stdin"`,
    `printf '{"args":"%s","token":"%s","home":"%s","config":"%s","apiKey":"%s","autoUpdater":"%s"}' "$*" "$CLAUDE_CODE_OAUTH_TOKEN" "$HOME" "$CLAUDE_CONFIG_DIR" "$ANTHROPIC_API_KEY" "$DISABLE_AUTOUPDATER" > "${record}"`,
    body,
  ].join("\n"), "utf8");
  chmodSync(path, 0o755);
  return { path, record };
}

function executor(claudePath: string, token: string | null = "oauth-token-1") {
  return new ClaudeEphemeralExecutor({
    claudePath,
    oneShotToken: async () => token,
    processEnv: { PATH: process.env.PATH, HOME: HOST_HOME, ANTHROPIC_API_KEY: "must-not-leak", CLAUDE_CONFIG_DIR: "/host-config" },
  });
}

const request = {
  prompt: "요약해 줘",
  model: "sonnet",
  reasoningEffort: "high" as const,
  timeoutMs: 10_000,
  maxAttempts: 1,
  concurrencyLimit: 1,
};

describe("Claude ephemeral executor", () => {
  it("runs claude with the central token in an isolated home and no API key", async () => {
    const { path, record } = fakeClaude("ok", `echo '{"type":"result","is_error":false,"result":"요약","modelUsage":{"claude-sonnet-5-5":{}},"usage":{"input_tokens":3,"output_tokens":4}}'`);
    const result = await executor(path).generate(request);

    expect(result).toMatchObject({ content: "요약", model: "claude-sonnet-5-5", attempts: 1 });
    expect(result.usage).toMatchObject({ input_tokens: 3, output_tokens: 4 });
    const seen = JSON.parse(readFileSync(record, "utf8")) as Record<string, string>;
    const { home, config } = seen as { home: string; config: string };
    expect(seen.token).toBe("oauth-token-1");
    expect(seen.home).not.toBe(HOST_HOME);
    expect(seen.config).not.toBe("/host-config");
    expect(config.startsWith(home)).toBe(true);
    expect(seen.apiKey).toBe("");
    expect(seen.autoUpdater).toBe("1");
    expect(seen.args).toContain("-p");
    expect(seen.args).toContain("--model sonnet");
    expect(seen.args).toContain("--effort high");
    expect(seen.args).toContain("--no-session-persistence");
    expect(seen.args).not.toContain("--bare");
    expect(seen.args).not.toContain("--max-turns");
    expect(seen.args).not.toContain("--json-schema");
    expect(readFileSync(`${record}.stdin`, "utf8")).toBe("요약해 줘");
  });

  it("passes the output schema and returns structured_output", async () => {
    const { path, record } = fakeClaude("schema", `echo '{"type":"result","is_error":false,"result":"","structured_output":{"a":"b"}}'`);
    const result = await executor(path).generate({
      ...request,
      outputSchema: { type: "object", properties: { a: { type: "string" } } },
    });
    expect(JSON.parse(result.content)).toEqual({ a: "b" });
    expect(result.model).toBe("sonnet");
    expect(readFileSync(record, "utf8")).toContain("--json-schema");
  });

  it("classifies a usage-limit message as CLAUDE_USAGE_LIMIT", async () => {
    const { path } = fakeClaude("limit", `echo '{"type":"result","is_error":true,"result":"You have hit your usage limit. five_hour"}'; exit 1`);
    await expect(executor(path).generate(request)).rejects.toMatchObject({ code: "CLAUDE_USAGE_LIMIT" });
  });

  it("classifies a missing executable as CLAUDE_UNAVAILABLE", async () => {
    await expect(executor(join(root, "does-not-exist")).generate(request))
      .rejects.toMatchObject({ code: "CLAUDE_UNAVAILABLE" });
  });

  it("classifies a missing central account as CLAUDE_UNAVAILABLE without starting claude", async () => {
    const { path, record } = fakeClaude("none", "echo '{}'");
    await expect(executor(path, null).generate(request)).rejects.toMatchObject({ code: "CLAUDE_UNAVAILABLE" });
    expect(() => readFileSync(record, "utf8")).toThrow();
  });

  it("classifies a slow run as CLAUDE_TIMEOUT", async () => {
    const { path } = fakeClaude("slow", "sleep 5");
    await expect(executor(path).generate({ ...request, timeoutMs: 300 }))
      .rejects.toMatchObject({ code: "CLAUDE_TIMEOUT" });
  });
});
