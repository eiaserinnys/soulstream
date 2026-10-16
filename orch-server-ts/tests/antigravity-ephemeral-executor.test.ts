import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  AntigravityEphemeralExecutor,
  NodeAntigravityExecProcess,
  type AntigravityExecProcessPort,
} from "../src/llm/antigravity_ephemeral_executor.js";

const request = {
  prompt: "한 줄 답글", model: "gemini-4-argon", reasoningEffort: "high" as const,
  timeoutMs: 1_000, maxAttempts: 1, concurrencyLimit: 1,
};
const success = (result: Record<string, unknown>) => [
  JSON.stringify({ event: "init", init: { model: "resolved-argon" } }),
  JSON.stringify({ event: "result", result: { status: "SUCCESS", ...result } }),
].join("\n");

describe("Antigravity ephemeral executor", () => {
  it("uses structured output, sanitized env and isolated stdin/schema files, then cleans up", async () => {
    let cwd = "";
    const schema = { type: "object", properties: { reply: { type: "string" } } };
    const execute: AntigravityExecProcessPort["execute"] = vi.fn(async (invocation, input) => {
      cwd = invocation.cwd;
      expect(JSON.parse(input)).toEqual({ event: "user", message: { content: request.prompt } });
      expect(input.endsWith("\n")).toBe(true);
      expect(invocation.command).toBe("/fake/agy");
      expect(invocation.args).toEqual([
        "--output-format", "stream-json", "--input-format", "stream-json",
        "--sandbox", "--disable-slash-commands", "--json-schema", `${cwd}/output-schema.json`,
        "--log-file", `${cwd}/agy.log`, "--model", "gemini-4-argon", "--effort", "high",
      ]);
      expect(JSON.parse(await readFile(`${cwd}/output-schema.json`, "utf8"))).toEqual(schema);
      expect(invocation.env).toEqual({ PATH: "/bin" });
      return { stdout: success({ response: '{"toolAction":"bad"}', structured_output: { reply: "안녕" },
        usage: { input_tokens: 11, output_tokens: 7, thinking_tokens: 4 } }), stderr: "", exitCode: 0 };
    });
    const executor = new AntigravityEphemeralExecutor({ agyPath: "/fake/agy", processPort: { execute },
      processEnv: { PATH: "/bin", OPENAI_API_KEY: "blocked" } });
    await expect(executor.generate({ ...request, outputSchema: schema })).resolves.toMatchObject({
      content: '{"reply":"안녕"}', model: "resolved-argon", attempts: 1,
      usage: { input_tokens: 11, output_tokens: 7 }, peakConcurrentSpawns: 1,
    });
    expect(existsSync(cwd)).toBe(false);
  });

  it("uses response without a schema and the requested model without init", async () => {
    const executor = new AntigravityEphemeralExecutor({ agyPath: "agy", processPort: {
      execute: async () => ({ stdout: JSON.stringify({ event: "result", result: {
        status: "SUCCESS", response: "plain reply" } }), stderr: "", exitCode: 0 }),
    } });
    await expect(executor.generate(request)).resolves.toMatchObject({ content: "plain reply", model: request.model });
  });

  it.each([
    { stdout: success({ status: "ERROR", error: "RESOURCE_EXHAUSTED original" }), stderr: "", exitCode: 0 },
    { stdout: JSON.stringify({ event: "step_update", step_update: { step_type: "error_message", text_delta: "quota original" } }), stderr: "", exitCode: 1 },
    { stdout: "", stderr: "429 rate limit original", exitCode: 1 },
  ])("classifies quota from result, error steps, or stderr without retry", async (output) => {
    const execute = vi.fn(async () => output);
    const executor = new AntigravityEphemeralExecutor({ agyPath: "agy", processPort: { execute } });
    await expect(executor.generate({ ...request, maxAttempts: 3 })).rejects.toMatchObject({
      code: "ANTIGRAVITY_RATE_LIMITED", message: expect.stringContaining("original"), metrics: { attempts: 1 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["broken NDJSON", success({ response: "schema missing" })])("rejects invalid structured output", async (stdout) => {
    const executor = new AntigravityEphemeralExecutor({ agyPath: "agy", processPort: {
      execute: async () => ({ stdout, stderr: "", exitCode: 0 }),
    } });
    await expect(executor.generate({ ...request, outputSchema: { type: "object" } })).rejects.toMatchObject({ code: "ANTIGRAVITY_INVALID_OUTPUT" });
  });

  it("retries ordinary failures up to maxAttempts and requires SUCCESS plus exit zero", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ stdout: success({ response: "wrong exit" }), stderr: "failed", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: success({ response: "ok" }), stderr: "", exitCode: 0 });
    await expect(new AntigravityEphemeralExecutor({ agyPath: "agy", processPort: { execute } })
      .generate({ ...request, maxAttempts: 2 })).resolves.toMatchObject({ content: "ok", attempts: 2 });
  });

  it("reports unavailable CLI without spawning", async () => {
    await expect(new AntigravityEphemeralExecutor({}).generate(request)).rejects.toMatchObject({
      code: "ANTIGRAVITY_UNAVAILABLE", metrics: { attempts: 0 },
    });
  });

  it("serializes its own concurrent requests", async () => {
    let active = 0;
    let peak = 0;
    const executor = new AntigravityEphemeralExecutor({ agyPath: "agy", processPort: {
      execute: async () => {
        active += 1; peak = Math.max(active, peak);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return { stdout: success({ response: "ok" }), stderr: "", exitCode: 0 };
      },
    } });
    await Promise.all([executor.generate(request), executor.generate(request)]);
    expect(peak).toBe(1);
  });

  it("kills and reaps a timed out process and reports timing", async () => {
    const onProcessTiming = vi.fn();
    const port = new NodeAntigravityExecProcess({ onProcessTiming });
    await expect(port.execute({ command: process.execPath, args: ["-e", "process.stdin.resume(); setTimeout(() => {}, 1000)"],
      cwd: tmpdir(), env: process.env as Record<string, string> }, "", 40)).rejects.toMatchObject({ code: "ANTIGRAVITY_TIMEOUT" });
    expect(onProcessTiming).toHaveBeenCalledWith(expect.objectContaining({ timedOut: true }));
  });
});
