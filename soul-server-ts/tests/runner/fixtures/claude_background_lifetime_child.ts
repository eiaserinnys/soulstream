import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";

import type {
  EngineExecuteParams,
  EngineInterventionResult,
  EnginePort,
  SSEEventPayload,
} from "../../../src/engine/protocol.js";
import {
  engineEventFrame,
  type RunnerEventFrame,
} from "../../../src/runner/frame_protocol.js";
import { RunnerChildRuntime } from "../../../src/runner/runner_child_runtime.js";
import type { RunnerHostRequestClient } from
  "../../../src/runner/runner_host_request_client.js";
import { parseRunnerChildConfig } from "../../../src/runner/runner_process_spawn.js";

const configPath = argument("--config");
const config = parseRunnerChildConfig(JSON.parse(await readFile(configPath, "utf8")));
const controlDirectory = config.agent.workspace_dir;
const markerWorkerPath = join(controlDirectory, "marker-worker.mjs");
const logger = pino({ level: "silent" });

class DeterministicBackgroundEngine implements EnginePort {
  readonly backendId = "claude" as const;
  readonly detachedClaudeRuntime = true as const;
  readonly workspaceDir = config.agent.workspace_dir;
  private readonly children = new Set<ChildProcess>();
  private readonly finalizers = new Set<Promise<void>>();
  private backgroundTaskCount = 0;

  constructor(private readonly host: RunnerHostRequestClient) {}

  async *execute(_params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {}

  async *executeFrames(_params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    const replay = (await readLines(join(controlDirectory, "spawn.log"))).length > 0;
    const taskId = replay ? "task-a-red-replay" : "task-a-red-original";
    const toolUseId = replay ? "tool-a-red-replay" : "tool-a-red-original";
    const outputFile = join(controlDirectory, `${taskId}.output`);
    await writeFile(outputFile, `${taskId}:started\n`);

    const child = spawn(process.execPath, [markerWorkerPath, controlDirectory], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("deterministic background worker omitted its pid");
    child.unref();
    this.children.add(child);
    this.backgroundTaskCount += 1;
    const finalizer = this.finalizeChild(child, taskId, toolUseId, outputFile);
    this.finalizers.add(finalizer);
    void finalizer.finally(() => this.finalizers.delete(finalizer));

    await this.host.call("claude_runtime", "observe", [config.sessionId, {
      type: "claude_runtime_task_started",
      taskId,
      toolUseId,
      description: "deterministic side-effect marker",
      taskType: "bash",
      timestamp: Date.now(),
    }], { timeoutMs: 20_000 });

    yield engineEventFrame({ type: "session", session_id: `backend-${taskId}` });
    yield engineEventFrame({
      type: "tool_result",
      tool_name: "Bash",
      tool_use_id: toolUseId,
      result: `Background task ${taskId}. Output is being written to: ${outputFile}`,
      is_error: false,
      timestamp: Date.now(),
    } as SSEEventPayload);
    yield engineEventFrame({
      type: "complete",
      result: `foreground released ${taskId}`,
      timestamp: Date.now(),
    });
  }

  async detachedClaudeRuntimeActivity() {
    return {
      foregroundPhase: "drain",
      queryLifecycle: "open",
      backgroundTaskCount: this.backgroundTaskCount,
      pendingInputRequestCount: 0,
      pendingRuntimeSignalCount: 0,
    };
  }

  async intervene(): Promise<EngineInterventionResult> {
    return {
      status: "not_delivered",
      mechanism: "unsupported",
      reason: "not_supported",
    };
  }

  async interrupt(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    for (const child of this.children) child.kill("SIGTERM");
    await Promise.all([...this.finalizers]);
  }

  private async finalizeChild(
    child: ChildProcess,
    taskId: string,
    toolUseId: string,
    outputFile: string,
  ): Promise<void> {
    try {
      await once(child, "exit");
      const terminalMarker = `${child.pid}:terminal-ok`;
      if (!(await readLines(join(controlDirectory, "terminal.log"))).includes(terminalMarker)) {
        return;
      }
      const event = {
        type: "claude_runtime_task_notification" as const,
        taskId,
        toolUseId,
        status: "completed" as const,
        summary: `${taskId} completed`,
        outputFile,
        timestamp: Date.now(),
      };
      await this.host.call(
        "claude_runtime",
        "observe",
        [config.sessionId, event],
        { timeoutMs: 20_000 },
      );
      await this.host.call(
        "detached_event",
        "publish",
        [config.sessionId, event],
        { timeoutMs: 20_000 },
      );
    } finally {
      this.children.delete(child);
      this.backgroundTaskCount -= 1;
    }
  }
}

const runtime = new RunnerChildRuntime(config, logger, {
  createEngine: (_config, host) => new DeterministicBackgroundEngine(host),
});
process.once("SIGTERM", () => { void runtime.shutdown(); });
process.once("SIGINT", () => { void runtime.shutdown(); });
await runtime.start();
await runtime.waitUntilClosed();

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`A lifetime child requires ${name}`);
  return value;
}
