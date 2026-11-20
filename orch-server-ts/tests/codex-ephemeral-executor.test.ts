import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexExecInvocation,
  CodexEphemeralExecutor,
  NodeCodexExecProcess,
} from "../src/llm/codex_ephemeral_executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("Codex ephemeral query-only execution", () => {
  it("observes child spawn-to-first-output and spawn-to-close timings", async () => {
    const observations: Array<Record<string, unknown>> = [];
    const processPort = new NodeCodexExecProcess({
      onProcessTiming: (timing: Record<string, unknown>) => observations.push(timing),
    } as never);
    const script = 'setTimeout(() => process.stdout.write("ready"), 40); setTimeout(() => process.exit(0), 100)';

    await expect(processPort.execute({
      command: process.execPath,
      args: ["-e", script],
      env: process.env as Record<string, string>,
      cwd: tmpdir(),
    }, "", 1_000)).resolves.toMatchObject({ stdout: "ready" });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(expect.objectContaining({
      spawnToFirstStdoutMs: expect.any(Number),
      spawnToCloseMs: expect.any(Number),
      timedOut: false,
      cancelled: false,
    }));
    expect(observations[0]?.spawnToFirstStdoutMs).toBeGreaterThan(0);
    expect(observations[0]?.spawnToCloseMs).toBeGreaterThanOrEqual(
      observations[0]?.spawnToFirstStdoutMs as number,
    );
  });

  it("passes a resolved model, max effort, and explicit no-tools flags", () => {
    const invocation = buildCodexExecInvocation({
      codexPath: "/usr/local/bin/codex",
      workspaceDir: "/tmp/codex-search",
      model: "model-from-catalog",
      reasoningEffort: "max",
      processEnv: {},
      disabledFeatures: ["shell_tool", "apps", "multi_agent"],
      disableWebSearch: true,
    });

    expect(invocation.args).toContain("model-from-catalog");
    expect(invocation.args).toContain('model_reasoning_effort="max"');
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--disable",
      "shell_tool",
      "apps",
      "multi_agent",
      'web_search="disabled"',
    ]));
  });

  it("carries the stdout JSONL error body and classifies a usage limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-usage-limit-"));
    temporaryDirectories.push(directory);
    const script = join(directory, "fake-codex.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        "cat <<'EOF'",
        '{"type":"thread.started","thread_id":"t"}',
        '{"type":"error","message":"You\'ve hit your usage limit."}',
        '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}',
        "EOF",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const processPort = new NodeCodexExecProcess();
    await expect(processPort.execute({
      command: script,
      args: [],
      env: process.env as Record<string, string>,
      cwd: directory,
    }, "", 1_000)).rejects.toMatchObject({
      code: "CODEX_USAGE_LIMIT",
      message: expect.stringContaining("usage limit"),
    });
  });

  it("keeps other failures as exec failures with the JSONL message and stderr tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-exec-failure-"));
    temporaryDirectories.push(directory);
    const script = join(directory, "fake-codex.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        "cat <<'EOF'",
        '{"type":"turn.failed","error":{"message":"responses websocket failed"}}',
        "EOF",
        "printf 'stderr tail line' >&2",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const processPort = new NodeCodexExecProcess();
    await expect(processPort.execute({
      command: script,
      args: [],
      env: process.env as Record<string, string>,
      cwd: directory,
    }, "", 1_000)).rejects.toMatchObject({
      code: "CODEX_EXEC_FAILED",
      message: expect.stringMatching(
        /responses websocket failed[\s\S]*stderr tail line/,
      ),
    });
  });

  it("does not retry an attempt that hit the usage limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-no-retry-"));
    temporaryDirectories.push(directory);
    const counter = join(directory, "attempts.txt");
    const script = join(directory, "fake-codex.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        `printf 'x\\n' >> ${JSON.stringify(counter)}`,
        "cat <<'EOF'",
        '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}',
        "EOF",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    const executor = new CodexEphemeralExecutor({
      codexPath: script,
      processPort: new NodeCodexExecProcess(),
    });

    await expect(executor.generate({
      prompt: "hi",
      model: "test-model",
      reasoningEffort: "low",
      timeoutMs: 1_000,
      maxAttempts: 2,
      concurrencyLimit: 1,
    })).rejects.toMatchObject({
      code: "CODEX_USAGE_LIMIT",
      metrics: { attempts: 1 },
    });
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("kills and reaps an active child when its signal aborts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-abort-test-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "child-ran-after-abort");
    const controller = new AbortController();
    const processPort = new NodeCodexExecProcess();
    const delayedChild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 300)`;
    const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(delayedChild)}], { stdio: "ignore" }); setTimeout(() => undefined, 1000)`;
    const execution = processPort.execute({
      command: process.execPath,
      args: [
        "-e",
        parentScript,
      ],
      env: process.env as Record<string, string>,
      cwd: directory,
    }, "", 1_000, controller.signal);

    setTimeout(() => controller.abort(), 40);

    await expect(execution).rejects.toMatchObject({ code: "CODEX_CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(existsSync(marker)).toBe(false);
  });
});
