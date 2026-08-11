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

  constructor(
    private readonly controlDirectory: string,
    readonly workspaceDir: string,
  ) {}

  async *execute(_params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {}

  async *executeFrames(_params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    if (process.env.RUNNER_E2E_REQUIRE_INTERNAL_MCP === "1") {
      await exerciseInternalMcp();
    }
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

async function exerciseInternalMcp(): Promise<void> {
  const options = buildMcpOptions({
    prompt: "runner cutover internal MCP smoke",
    workspaceDir: config.agent.workspace_dir,
    agentSessionId: config.sessionId,
    resolvedMcpServers: config.resolvedMcpServers,
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
