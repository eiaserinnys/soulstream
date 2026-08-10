import { access, readFile, writeFile } from "node:fs/promises";

import pino from "pino";

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
  readonly backendId = "openai-agents" as const;

  constructor(
    private readonly controlDirectory: string,
    readonly workspaceDir: string,
  ) {}

  async *execute(_params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {}

  async *executeFrames(_params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
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
