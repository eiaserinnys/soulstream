import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeEngineAdapter } from "../../../src/engine/opencode/adapter.js";

function fixture(extraEvents: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), "opencode-adapter-"));
  const workspaceDir = join(root, "workspace");
  const sessionDirectory = join(root, "session");
  const executablePath = join(root, "fake-opencode.sh");
  const fixturePath = join(root, "fake-opencode.mjs");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(fixturePath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const sessionID = args.includes('--session') ? value('--session') : 'ses_adapter_398';
const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
const env = {
  sessionID,
  opencodeApiKey: process.env.OPENCODE_API_KEY ?? null,
  xdgDataHome: process.env.XDG_DATA_HOME,
  instructionText: config.instructions?.[0] ? readFileSync(config.instructions[0], 'utf8') : null,
  prompt,
  args,
};
for (const event of ${JSON.stringify(extraEvents)}) console.log(JSON.stringify(event));
console.log(JSON.stringify({ type: 'text', sessionID, part: { type: 'text', text: JSON.stringify(env) } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID, part: { type: 'step-finish', reason: 'stop', cost: 0.25 } }));
`);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(executablePath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} "$@"\n`, { mode: 0o700 });
  chmodSync(executablePath, 0o700);
  return { root, workspaceDir, sessionDirectory, executablePath };
}

function rateLimitFixture(options: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "opencode-rate-limit-"));
  const workspaceDir = join(root, "workspace");
  const sessionDirectory = join(root, "session");
  const executablePath = join(root, "fake-opencode.sh");
  const fixturePath = new URL("./fixtures/rate-limit-cli.mjs", import.meta.url).pathname;
  const startedPath = join(root, "child-started");
  const signalPath = join(root, "child-interrupted");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(sessionDirectory, { recursive: true });
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(executablePath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} "$@"\n`, { mode: 0o700 });
  chmodSync(executablePath, 0o700);
  writeFileSync(join(sessionDirectory, "rate-limit-fixture.json"), JSON.stringify({
    ...options,
    startedPath,
    signalPath,
  }));
  return { root, workspaceDir, sessionDirectory, executablePath, startedPath, signalPath };
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for fixture marker: ${path}`);
}

const input = {
  agentSessionId: "session-adapter-398",
  prompt: "첫 요청",
  model: "opencode/deepseek-v4.1-flash-free",
  systemPrompt: "adapter instructions",
};

async function collect(engine: OpenCodeEngineAdapter, params = input) {
  const events = [];
  for await (const event of engine.execute(params)) events.push(event);
  return events;
}

describe("OpenCodeEngineAdapter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs the CLI without a shell, sends UTF-8 stdin, and maps the returned session and events", async () => {
    const paths = fixture();
    const engine = new OpenCodeEngineAdapter({
      ...paths,
      agentId: "test-agent",
      processEnv: { ...process.env, OPENCODE_API_KEY: "must-not-pass" },
    }, pino({ level: "silent" }));
    try {
      const events = await collect(engine);
      const session = events.find((event) => event.type === "session");
      const assistant = events.find((event) => event.type === "assistant_message");
      const complete = events.find((event) => event.type === "complete");
      expect(session).toMatchObject({ type: "session", session_id: "ses_adapter_398" });
      expect(assistant?.type === "assistant_message" ? JSON.parse(assistant.content) : null).toMatchObject({
        sessionID: "ses_adapter_398",
        opencodeApiKey: null,
        xdgDataHome: join(paths.sessionDirectory, "xdg", "data"),
        instructionText: "adapter instructions",
        prompt: "첫 요청",
        args: ["--print-logs", "--log-level", "ERROR", "run", "--pure", "--format", "json", "--model", "opencode/deepseek-v4.1-flash-free"],
      });
      expect(complete).toMatchObject({ type: "complete", turn_cost_usd: 0.25 });
    } finally {
      await engine.close();
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("reuses the supplied backend session ID on a resumed process", async () => {
    const paths = fixture();
    mkdirSync(join(paths.sessionDirectory, "opencode"), { recursive: true });
    writeFileSync(join(paths.sessionDirectory, "opencode", "system-prompt.md"), "adapter instructions", { mode: 0o600 });
    const engine = new OpenCodeEngineAdapter({ ...paths, agentId: "test-agent", processEnv: {} }, pino({ level: "silent" }));
    try {
      const events = await collect(engine, { ...input, systemPrompt: undefined, resumeSessionId: "ses_resume_398" });
      const assistant = events.find((event) => event.type === "assistant_message");
      expect(events.find((event) => event.type === "session")).toMatchObject({ session_id: "ses_resume_398" });
      expect(assistant?.type === "assistant_message" ? JSON.parse(assistant.content) : null).toMatchObject({
        args: ["--print-logs", "--log-level", "ERROR", "run", "--pure", "--format", "json", "--model", "opencode/deepseek-v4.1-flash-free", "--session", "ses_resume_398"],
      });
      expect(readFileSync(join(paths.sessionDirectory, "opencode", "system-prompt.md"), "utf8")).toBe("adapter instructions");
    } finally {
      await engine.close();
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("reports a missing CLI path only when an OpenCode turn executes", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-uninstalled-"));
    const engine = new OpenCodeEngineAdapter({ workspaceDir: root, agentId: "test-agent", sessionDirectory: join(root, "session"), processEnv: {} }, pino({ level: "silent" }));
    try {
      expect(await collect(engine)).toMatchObject([
        { type: "error", fatal: true, message: expect.stringContaining("OPENCODE_CLI_PATH") },
      ]);
    } finally {
      await engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a stderr-only rate limit once and interrupts the waiting CLI without exposing stderr", async () => {
    const paths = rateLimitFixture({ mode: "rate-limit", small: false, splitChunks: true, duplicate: true });
    const logLines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(String(chunk));
        callback();
      },
    });
    const engine = new OpenCodeEngineAdapter({
      ...paths,
      agentId: "roselin",
      processEnv: {},
    }, pino({ level: "warn" }, destination));
    try {
      const events = await collect(engine);
      expect(readFileSync(paths.signalPath, "utf8")).toBe("SIGINT");
      expect(events.filter((event) => event.type === "error")).toMatchObject([
        {
          type: "error",
          fatal: true,
          message: "OpenCode free tier rate limit exceeded (Rate limit exceeded). Try again later or use another model.",
        },
      ]);
      expect(events.some((event) => event.type === "complete")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("FAKE_STDERR_SECRET");
      expect(logLines.join("\n")).not.toContain("FAKE_STDERR_SECRET");
    } finally {
      await engine.close();
      destination.end();
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("ignores the same rate-limit error from a small model request", async () => {
    const paths = rateLimitFixture({ mode: "complete", small: true });
    const engine = new OpenCodeEngineAdapter({
      ...paths,
      agentId: "roselin",
      processEnv: {},
    }, pino({ level: "silent" }));
    try {
      const events = await collect(engine);
      expect(events.some((event) => event.type === "error" && event.fatal)).toBe(false);
      expect(events).toMatchObject([
        { type: "session", session_id: "ses_rate_limit_fixture" },
        { type: "assistant_message", content: "small request completed" },
        { type: "complete", status: "completed", result: "small request completed" },
      ]);
    } finally {
      await engine.close();
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("keeps user cancellation deferred until the first stdout event", async () => {
    const paths = rateLimitFixture({ mode: "cancel-before-stdout" });
    const engine = new OpenCodeEngineAdapter({
      ...paths,
      agentId: "roselin",
      processEnv: {},
    }, pino({ level: "silent" }));
    try {
      const result = collect(engine);
      await waitForFile(paths.startedPath);
      expect(await engine.interrupt()).toBe(true);
      const events = await result;
      expect(events.some((event) => event.type === "session" && event.session_id === "ses_cancel_fixture")).toBe(true);
      expect(events.some((event) => event.type === "error" && event.fatal)).toBe(false);
      expect(events.some((event) => event.type === "complete")).toBe(false);
      expect(readFileSync(paths.signalPath, "utf8")).toBe("SIGINT");
    } finally {
      await engine.close();
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("warns once per out-of-allowlist call without logging arguments, errors, or headers", async () => {
    const blocked = {
      type: "tool_use",
      sessionID: "ses_adapter_398",
      part: {
        type: "tool",
        tool: "invalid",
        callID: "blocked-call",
        state: {
          status: "error",
          input: { tool: "soulstream_hidden", secret: "ARGUMENT_SECRET" },
          error: "ERROR_SECRET",
        },
      },
    };
    const allowedTool = (tool: string, callID: string, status: string) => ({
      type: "tool_use",
      sessionID: "ses_adapter_398",
      part: {
        type: "tool",
        tool,
        callID,
        state: {
          status,
          input: { harmless: true },
          ...(status === "error" ? { error: "ordinary argument error" } : { output: "ok" }),
        },
      },
    });
    const paths = fixture([
      blocked,
      blocked,
      allowedTool("soulstream_other", "direct-call", "error"),
      allowedTool("soulstream_get_session_name", "allowed-call", "completed"),
      allowedTool("soulstream_get_session_name", "argument-error-call", "error"),
      {
        type: "tool_use",
        sessionID: "ses_adapter_398",
        part: {
          type: "tool",
          tool: "invalid",
          callID: "unrelated-call",
          state: { status: "error", input: { tool: "exa_hidden" }, error: "not-ours" },
        },
      },
    ]);
    const logLines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(String(chunk));
        callback();
      },
    });
    const engine = new OpenCodeEngineAdapter({
      ...paths,
      agentId: "roselin",
      processEnv: {},
      internalMcpUrl: "http://127.0.0.1:4206/mcp",
      resolvedMcpServers: [{
        type: "streamable_http",
        name: "soulstream",
        url: "http://127.0.0.1:4206/mcp",
        headers: { Authorization: "HEADER_SECRET" },
      }],
    }, pino({ level: "warn" }, destination));
    try {
      const events = await collect(engine, {
        ...input,
        opencodeMcpToolAllowlist: { soulstream: ["get_session_name"] },
      });
      const warnings = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === "OpenCode MCP tool call is outside the configured allowlist");

      expect(warnings).toHaveLength(2);
      expect(warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          agentId: "roselin",
          agentSessionId: "session-adapter-398",
          backendSessionId: "ses_adapter_398",
          toolName: "soulstream_hidden",
        }),
        expect.objectContaining({ toolName: "soulstream_other" }),
      ]));
      expect(logLines.join("\n")).not.toContain("ARGUMENT_SECRET");
      expect(logLines.join("\n")).not.toContain("ERROR_SECRET");
      expect(logLines.join("\n")).not.toContain("HEADER_SECRET");
      expect(events.filter((event) => event.type === "tool_start")).toHaveLength(5);
      expect(events.some((event) => event.type === "tool_result" && event.is_error)).toBe(true);
    } finally {
      await engine.close();
      destination.end();
      rmSync(paths.root, { recursive: true, force: true });
    }
  });
});
