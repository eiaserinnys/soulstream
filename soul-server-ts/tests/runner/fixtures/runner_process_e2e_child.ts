import { access, readFile, writeFile } from "node:fs/promises";

import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ClaudeRunOptions } from "../../../src/engine/claude_adapter.js";
import { buildMcpOptions } from "../../../src/engine/claude_sdk_mcp_options.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "../../../src/engine/protocol.js";
import {
  engineEventFrame,
  type RunnerEventFrame,
} from "../../../src/runner/frame_protocol.js";
import { RunnerChildRuntime } from "../../../src/runner/runner_child_runtime.js";
import { parseRunnerChildConfig } from "../../../src/runner/runner_process_spawn.js";

const configPath = argument("--config");
const controlDirectory = required(process.env.RUNNER_E2E_CONTROL_DIR, "RUNNER_E2E_CONTROL_DIR");
const config = parseRunnerChildConfig(JSON.parse(await readFile(configPath, "utf8")));
class ControlledEngine implements EnginePort {
  readonly backendId = config.backend;
  private executionCount = 0;

  constructor(
    private readonly controlDirectory: string,
    readonly workspaceDir: string,
  ) {}

  async *execute(_params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {}

  async *executeFrames(_params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    const preBootstrapScenario = process.env.RUNNER_E2E_PRE_BOOTSTRAP_SCENARIO;
    if (preBootstrapScenario) {
      this.executionCount += 1;
      if (this.executionCount === 1) {
        if (preBootstrapScenario === "initial-crash") {
          yield preBootstrapHook("discarded-crash");
          throw new Error("fixture crashed before backend session ID");
        }
        if (preBootstrapScenario === "frame-count-overflow") {
          for (let index = 0; index <= 1_024; index += 1) {
            yield preBootstrapHook(`discarded-count-${index}`);
          }
          return;
        }
        if (preBootstrapScenario === "byte-overflow") {
          yield preBootstrapHook("discarded-bytes", "x".repeat(8 * 1024 * 1024));
          return;
        }
        throw new Error(`unknown pre-bootstrap scenario: ${preBootstrapScenario}`);
      }
      yield engineEventFrame({ type: "session", session_id: "backend-session-e2e" });
      yield engineEventFrame({
        type: "assistant_message",
        content: `execution-${this.executionCount}`,
        timestamp: this.executionCount + 1,
      });
      return;
    }
    if (process.env.RUNNER_E2E_ID_BOOTSTRAP === "1") {
      this.executionCount += 1;
      if (this.executionCount === 1) {
        yield engineEventFrame({
          type: "claude_runtime_hook_event",
          hook_event_name: "UserPromptSubmit",
          session_id: "backend-session-e2e",
          tool_use_id: "hook-e2e",
          hook_input: {},
          timestamp: 1,
        });
        yield engineEventFrame({ type: "session", session_id: "backend-session-e2e" });
      }
      yield engineEventFrame({
        type: "assistant_message",
        content: `execution-${this.executionCount}`,
        timestamp: this.executionCount + 1,
      });
      return;
    }
    if (process.env.RUNNER_E2E_REQUIRE_INTERNAL_MCP === "1") {
      await exerciseInternalMcp();
    }
    this.executionCount += 1;
    if (this.executionCount > 1) {
      await writeFile(`${this.controlDirectory}/followup-executed`, "ready\n");
    }
    // Match the real Claude/Codex ordering contract: an ID-bearing backend
    // publishes its backend session ID before the first durable turn event.
    yield engineEventFrame({ type: "session", session_id: "backend-session-e2e" });
    await writeFile(`${this.controlDirectory}/execute-started`, "ready\n");
    await waitForFile(`${this.controlDirectory}/emit-first`);
    yield engineEventFrame({
      type: "assistant_message",
      content: "before-detach",
      timestamp: 1,
    });
    await waitForFile(`${this.controlDirectory}/emit-after-detach`);
    yield engineEventFrame({
      type: "assistant_message",
      content: "after-detach",
      timestamp: 2,
    });
    await waitForFile(`${this.controlDirectory}/finish`);
  }

  async interrupt(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

function preBootstrapHook(label: string, blob?: string): RunnerEventFrame {
  return engineEventFrame({
    type: "claude_runtime_hook_event",
    hook_event_name: "UserPromptSubmit",
    session_id: "backend-session-e2e",
    tool_use_id: label,
    hook_input: blob === undefined ? {} : { blob },
    timestamp: 1,
  });
}

async function exerciseInternalMcp(): Promise<void> {
  const options = buildMcpOptions({
    prompt: "runner cutover internal MCP smoke",
    workspaceDir: config.agent.workspace_dir,
    agentSessionId: config.sessionId,
    resolvedMcpServers: config.resolvedMcpServers,
    internalMcpUrl: config.internalMcpUrl,
  } satisfies ClaudeRunOptions, pino({ level: "silent" }));
  const servers = options.mcpServers as Record<string, {
    type?: string;
    url?: string;
    headers?: Record<string, string>;
  }> | undefined;
  const server = servers?.soulstream;
  if (server?.type !== "http" || !server.url) {
    throw new Error("runner E2E expected resolved soulstream HTTP MCP server");
  }
  const client = new Client({ name: "runner-cutover-child", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    }));
    const result = await client.callTool({ name: "list_local_agents", arguments: {} });
    const url = new URL(server.url);
    await writeFile(
      `${controlDirectory}/internal-mcp-called`,
      JSON.stringify({ path: url.pathname, isError: result.isError === true }),
    );
  } finally {
    await client.close();
  }
}

const runtime = new RunnerChildRuntime(config, pino({ level: "silent" }), {
  createEngine: () => new ControlledEngine(controlDirectory, config.agent.workspace_dir),
});
process.once("SIGTERM", () => { void runtime.shutdown(); });
process.once("SIGINT", () => { void runtime.shutdown(); });
await runtime.start();
await runtime.waitUntilClosed();

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`runner E2E control timeout: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`runner E2E child requires ${name}`);
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} required`);
  return value;
}
