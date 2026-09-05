import { access, readFile, rename, writeFile } from "node:fs/promises";

import pino from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  claudeEngineEventMetadata,
  type ClaudeRunOptions,
} from "../../../src/engine/claude_adapter.js";
import { mapAppServerNotification } from
  "../../../src/engine/codex_app_server/event_mapper.js";
import { buildMcpOptions } from "../../../src/engine/claude_sdk_mcp_options.js";
import type {
  EngineExecuteParams,
  EngineInterventionResult,
  EnginePort,
  EngineUserInput,
  SSEEventPayload,
} from "../../../src/engine/protocol.js";
import {
  engineEventFrame,
  runnerRequestFrame,
  type RunnerEventFrame,
} from "../../../src/runner/frame_protocol.js";
import { RunnerChildRuntime } from "../../../src/runner/runner_child_runtime.js";
import type { RunnerHostRequestClient } from
  "../../../src/runner/runner_host_request_client.js";
import {
  applyRunnerClaudeRuntimeObservationResult,
} from "../../../src/runner/runner_claude_runtime_observation.js";
import { parseRunnerChildConfig } from "../../../src/runner/runner_process_spawn.js";

const configPath = argument("--config");
const controlDirectory = required(process.env.RUNNER_E2E_CONTROL_DIR, "RUNNER_E2E_CONTROL_DIR");
const config = parseRunnerChildConfig(JSON.parse(await readFile(configPath, "utf8")));
const logger = pino({ level: "silent" });
class ControlledEngine implements EnginePort {
  readonly backendId = config.backend;
  readonly detachedClaudeRuntime = config.backend === "claude" ? true : undefined;
  private executionCount = 0;
  private backgroundTaskCount = 0;
  private liveInterventionCount = 0;
  private p0r2InterruptCount = 0;
  private p0r2CloseCount = 0;
  private hostGapInterruptCount = 0;
  private fullSliceExecuteCount = 0;
  private fullSliceInterveneCount = 0;
  private fullSliceInterruptCount = 0;
  private fullSliceIntervention:
    | ((input: EngineUserInput) => void)
    | undefined;
  private fullSliceTurnInterrupted:
    | (() => void)
    | undefined;

  constructor(
    private readonly controlDirectory: string,
    readonly workspaceDir: string,
    private readonly host: RunnerHostRequestClient,
  ) {}

  async *execute(_params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {}

  async *executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    const fullSliceScenario = process.env.RUNNER_E2E_FULL_SLICE_SCENARIO;
    if (fullSliceScenario) {
      const expectedBackend = required(
        process.env.RUNNER_E2E_FULL_SLICE_BACKEND,
        "RUNNER_E2E_FULL_SLICE_BACKEND",
      );
      if (config.backend !== expectedBackend) {
        throw new Error(
          `${fullSliceScenario} requires ${expectedBackend}, received ${config.backend}`,
        );
      }
      this.fullSliceExecuteCount += 1;
      await this.writeFullSliceProbe({
        call: "executeFrames",
        scenario: fullSliceScenario,
        backend: config.backend,
        pid: process.pid,
        prompt: params.prompt ?? "",
        resumeSessionId: params.resumeSessionId ?? null,
      }, this.fullSliceExecuteCount);
      yield engineEventFrame({
        type: "session",
        session_id: `${fullSliceScenario}-${config.backend}-session`,
      });
      if (
        (fullSliceScenario === "S3" || fullSliceScenario === "S6")
        && config.backend === "claude"
        && this.fullSliceExecuteCount === 2
      ) {
        const reply = `${fullSliceScenario} ${config.backend} intervention reply`;
        yield engineEventFrame({ type: "assistant_message", content: reply, timestamp: 2 });
        yield engineEventFrame({ type: "complete", result: reply });
        return;
      }
      if (params.resumeSessionId) {
        await waitForFile(
          `${this.controlDirectory}/${fullSliceScenario}-${config.backend}-release-resume`,
        );
        const reply = `${fullSliceScenario} ${config.backend} resume reply`;
        yield engineEventFrame({ type: "assistant_message", content: reply, timestamp: 2 });
        yield engineEventFrame({ type: "complete", result: reply });
        return;
      }
      if (fullSliceScenario === "S3" || fullSliceScenario === "S6") {
        if (config.backend === "claude") {
          await new Promise<void>((resolve) => {
            this.fullSliceTurnInterrupted = resolve;
          });
          this.fullSliceTurnInterrupted = undefined;
          return;
        }
        await new Promise<EngineUserInput>((resolve) => {
          this.fullSliceIntervention = resolve;
        });
        const reply = `${fullSliceScenario} ${config.backend} intervention reply`;
        yield engineEventFrame({ type: "assistant_message", content: reply, timestamp: 2 });
        yield engineEventFrame({ type: "complete", result: reply });
        return;
      }
      await waitForFile(
        `${this.controlDirectory}/${fullSliceScenario}-${config.backend}-release-initial`,
      );
      const reply = `${fullSliceScenario} ${config.backend} initial reply`;
      yield engineEventFrame({ type: "assistant_message", content: reply, timestamp: 1 });
      yield engineEventFrame({ type: "complete", result: reply });
      return;
    }
    if (process.env.RUNNER_E2E_P0R2_SCENARIO === "1") {
      const firstExecutionPath = `${this.controlDirectory}/p0r2-first-execution.json`;
      const firstExecutionExists = await access(firstExecutionPath)
        .then(() => true)
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
      const generation = firstExecutionExists ? 2 : 1;
      if (generation === 1) {
        await writeJsonAtomically(
          firstExecutionPath,
          { pid: process.pid, params },
        );
        await waitForFile(`${this.controlDirectory}/p0r2-continue-first`);
      } else {
        await writeJsonAtomically(
          `${this.controlDirectory}/p0r2-successor-execution.json`,
          { pid: process.pid, params },
        );
        await waitForFile(`${this.controlDirectory}/p0r2-release-successor`);
      }
      yield engineEventFrame({
        type: "session",
        session_id: "backend-session-p0r2-1",
      });
      yield engineEventFrame({
        type: "assistant_message",
        content: generation === 1 ? "initial reply" : "successor reply",
        timestamp: generation,
      });
      yield engineEventFrame({
        type: "complete",
        result: generation === 1 ? "initial reply" : "successor reply",
      });
      return;
    }
    if (process.env.RUNNER_E2E_HOST_GAP_SCENARIO === "1") {
      yield engineEventFrame({ type: "session", session_id: "backend-session-e2e" });
      await writeFile(`${this.controlDirectory}/execute-started`, "ready\n");
      await waitForFile(`${this.controlDirectory}/emit-host-required-frame`);
      await writeFile(`${this.controlDirectory}/host-required-frame-emitted`, "ready\n");
      yield runnerRequestFrame("host-gap-can-use-tool", {
        kind: "can_use_tool",
        agentSessionId: config.sessionId,
        toolUseId: "host-gap-tool-use",
        toolName: "AskUserQuestion",
        input: { questions: [] },
      });
      await writeFile(`${this.controlDirectory}/host-required-frame-settled`, "ready\n");
      yield engineEventFrame({
        type: "assistant_message",
        content: "after-host-gap",
        timestamp: 2,
      });
      await waitForFile(`${this.controlDirectory}/finish-host-gap`);
      return;
    }
    if (process.env.RUNNER_E2E_BACKGROUND_SCENARIO === "multi-terminal") {
      this.executionCount += 1;
      if (this.executionCount === 1) {
        this.backgroundTaskCount = 2;
        yield engineEventFrame({ type: "session", session_id: "backend-session-background" });
        for (const taskId of ["background-1", "background-2"]) {
          yield engineEventFrame({
            type: "claude_runtime_task_updated",
            task_id: taskId,
            patch: { status: "running", is_backgrounded: true },
          });
        }
        void this.emitBackgroundTerminals().catch(async (error: unknown) => {
          await writeFile(
            `${this.controlDirectory}/child-error`,
            error instanceof Error ? error.stack ?? error.message : String(error),
          );
        });
        yield engineEventFrame({ type: "complete", result: "foreground complete" });
        return;
      }
      if (this.executionCount < 2 || this.executionCount > 3) {
        throw new Error(`background follow-up executed ${this.executionCount} times`);
      }
      await writeFile(
        `${this.controlDirectory}/followup-executed`,
        `${process.pid}\n`,
      );
      await writeFile(
        `${this.controlDirectory}/followup-execution-count`,
        `${this.executionCount - 1}\n`,
      );
      const followupResult = `background follow-up ${this.executionCount - 1} complete`;
      yield engineEventFrame({
        type: "assistant_message",
        content: followupResult,
        timestamp: 3,
      });
      yield engineEventFrame({ type: "complete", result: followupResult });
      return;
    }
    if (process.env.RUNNER_E2E_INTERVENTION_RECOVERY === "1") {
      await writeFile(
        `${this.controlDirectory}/recovered-intervention-execution.json`,
        JSON.stringify(params),
      );
      yield engineEventFrame({ type: "session", session_id: "backend-session-e2e" });
      await waitForFile(`${this.controlDirectory}/finish-recovered-intervention`);
      return;
    }
    const rolloverScenario = process.env.RUNNER_E2E_ROLLOVER_SCENARIO;
    if (rolloverScenario) {
      this.executionCount += 1;
      await writeFile(
        `${this.controlDirectory}/rollover-execution-${this.executionCount}.json`,
        JSON.stringify(params),
      );
      if (this.executionCount === 1) {
        yield engineEventFrame({ type: "session", session_id: "backend-session-old" });
        yield engineEventFrame({
          type: "context_usage",
          used_tokens: 160_000,
          max_tokens: 200_000,
          percent: 80,
        });
        yield engineEventFrame({ type: "complete", result: "before exhaustion" });
        return;
      }
      if (this.executionCount === 2) {
        yield engineEventFrame({
          type: "result",
          success: false,
          output: "Prompt is too long",
          terminal_reason: "prompt_too_long",
        });
        yield engineEventFrame({
          type: "error",
          message: "Prompt is too long",
          fatal: false,
          error_code: "claude_prompt_too_long",
        });
        return;
      }
      if (this.executionCount !== 3) {
        throw new Error(`rollover scenario replayed ${this.executionCount} times`);
      }
      yield engineEventFrame({ type: "session", session_id: "backend-session-fresh" });
      if (rolloverScenario === "refail") {
        yield engineEventFrame({
          type: "error",
          message: "Prompt is too long after rollover",
          fatal: false,
          error_code: "claude_prompt_too_long",
        });
        return;
      }
      if (rolloverScenario !== "success") {
        throw new Error(`unknown rollover scenario: ${rolloverScenario}`);
      }
      yield engineEventFrame({ type: "complete", result: "recovered" });
      return;
    }
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
    if (process.env.RUNNER_E2E_R57_STRUCTURED_RESULT === "1") {
      yield engineEventFrame({ type: "session", session_id: "backend-session-r57" });
      const item = {
        type: "mcpToolCall" as const,
        id: "tool-r57",
        server: "soulstream",
        tool: "list_session_events",
        arguments: { tool_content: "full" },
        status: "inProgress",
        result: null,
        error: null,
      };
      for (const event of mapAppServerNotification({
        method: "item/started",
        params: {
          threadId: "thread-r57",
          turnId: "turn-r57",
          startedAtMs: 1_000,
          item,
        },
      })) {
        yield engineEventFrame(event);
      }
      for (const event of mapAppServerNotification({
        method: "item/completed",
        params: {
          threadId: "thread-r57",
          turnId: "turn-r57",
          completedAtMs: 2_000,
          item: {
            ...item,
            status: "completed",
            result: amplifiedStructuredToolResult(),
          },
        },
      })) {
        yield engineEventFrame(event);
      }
      yield engineEventFrame({
        type: "assistant_message",
        content: "structured tool result preserved",
        timestamp: 3,
      });
      yield engineEventFrame({
        type: "complete",
        result: "structured tool result preserved",
        timestamp: 4,
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
    const fullSliceScenario = process.env.RUNNER_E2E_FULL_SLICE_SCENARIO;
    if (fullSliceScenario && config.backend === "claude") {
      this.fullSliceInterruptCount += 1;
      await this.writeFullSliceProbe({
        call: "interrupt",
        scenario: fullSliceScenario,
        backend: config.backend,
        pid: process.pid,
      }, this.fullSliceInterruptCount);
    }
    if (process.env.RUNNER_E2E_P0R2_SCENARIO === "1") {
      this.p0r2InterruptCount += 1;
      await writeFile(
        `${this.controlDirectory}/p0r2-interrupt-${process.pid}-${this.p0r2InterruptCount}`,
        "interrupted\n",
      );
    }
    if (process.env.RUNNER_E2E_HOST_GAP_SCENARIO === "1") {
      this.hostGapInterruptCount += 1;
      await writeFile(
        `${this.controlDirectory}/host-gap-interrupt-count`,
        `${this.hostGapInterruptCount}\n`,
      );
    }
    if (process.env.RUNNER_E2E_R57_STRUCTURED_RESULT === "1") {
      await writeFile(`${this.controlDirectory}/r57-interrupted`, "interrupted\n");
    }
    return true;
  }

  async intervene(input: EngineUserInput): Promise<EngineInterventionResult> {
    const fullSliceScenario = process.env.RUNNER_E2E_FULL_SLICE_SCENARIO;
    if (fullSliceScenario) {
      const interruptTurn = this.fullSliceTurnInterrupted;
      const deliverIntervention = this.fullSliceIntervention;
      const hasActiveTurn = config.backend === "claude"
        ? interruptTurn !== undefined
        : deliverIntervention !== undefined;
      this.fullSliceInterveneCount += 1;
      if (!hasActiveTurn) {
        const result: EngineInterventionResult = {
          status: "not_delivered",
          mechanism: config.backend === "claude"
            ? "interrupt_then_next_turn"
            : "active_turn",
          reason: "no_active_turn",
          message: "Full-slice fixture has no active turn",
        };
        await this.writeFullSliceProbe({
          call: "intervene",
          scenario: fullSliceScenario,
          backend: config.backend,
          pid: process.pid,
          prompt: input.prompt,
          result,
        }, this.fullSliceInterveneCount);
        return result;
      }
      if (config.backend === "claude") {
        this.fullSliceTurnInterrupted = undefined;
      } else {
        this.fullSliceIntervention = undefined;
      }
      const result: EngineInterventionResult = config.backend === "claude"
        ? {
            status: "not_delivered",
            mechanism: "interrupt_then_next_turn",
            reason: "next_turn_required",
          }
        : { status: "delivered", mechanism: "active_turn" };
      if (config.backend === "claude") await this.interrupt();
      await this.writeFullSliceProbe({
        call: "intervene",
        scenario: fullSliceScenario,
        backend: config.backend,
        pid: process.pid,
        prompt: input.prompt,
        result,
      }, this.fullSliceInterveneCount);
      if (config.backend === "claude") interruptTurn!();
      else deliverIntervention!(input);
      return result;
    }
    this.liveInterventionCount += 1;
    await writeFile(
      `${this.controlDirectory}/live-intervention-received.json`,
      JSON.stringify({ count: this.liveInterventionCount, input }),
    );
    return { status: "delivered", mechanism: "active_turn" };
  }

  async compact(_resumeSessionId: string): Promise<void> {
    if (process.env.RUNNER_E2E_ROLLOVER_SCENARIO) {
      await writeFile(`${this.controlDirectory}/rollover-compact-attempted`, "ready\n");
      throw new Error("compact boundary not observed");
    }
  }

  async close(): Promise<void> {
    if (process.env.RUNNER_E2E_P0R2_SCENARIO === "1") {
      this.p0r2CloseCount += 1;
      await writeFile(
        `${this.controlDirectory}/p0r2-close-${process.pid}-${this.p0r2CloseCount}`,
        "closed\n",
      );
      if (this.p0r2CloseCount === 2) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
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

  private async writeFullSliceProbe(
    input: Record<string, unknown>,
    callCount: number,
  ): Promise<void> {
    await writeJsonAtomically(
      `${this.controlDirectory}/engine-boundary-${String(input.scenario)}-${String(input.backend)}-${String(input.call)}-${process.pid}-${callCount}.json`,
      input,
    );
  }

  private async emitBackgroundTerminals(): Promise<void> {
    for (const [index, taskId] of ["background-1", "background-2"].entries()) {
      await waitForFile(`${this.controlDirectory}/release-${taskId}`);
      const event = {
        type: "claude_runtime_task_notification" as const,
        taskId,
        status: "completed" as const,
        summary: `${taskId} done`,
        timestamp: index + 10,
      };
      const metadata = {
        claudePostResultDrain: true,
        claudeBackgroundProvenance: "sdk_membership",
      };
      const observation = await this.host.call(
        "claude_runtime",
        "observe",
        [config.sessionId, event, metadata],
        { timeoutMs: 20_000 },
      );
      applyRunnerClaudeRuntimeObservationResult(
        event,
        observation,
        (issue) => logger.error(
          { err: issue },
          "Runner E2E observation response violated its semantic contract",
        ),
      );
      this.backgroundTaskCount -= 1;
      const detachedMetadata = claudeEngineEventMetadata(event);
      await this.host.call(
        "detached_event",
        "publish",
        [config.sessionId, { ...event }, ...(detachedMetadata ? [detachedMetadata] : [])],
        { timeoutMs: 20_000 },
      );
      await writeFile(`${this.controlDirectory}/published-${taskId}`, "ready\n");
    }
  }
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

function amplifiedStructuredToolResult() {
  return {
    content: [{
      type: "text",
      text: String.raw`\"`.repeat(300_000),
    }],
  };
}

async function exerciseInternalMcp(): Promise<void> {
  const options = buildMcpOptions({
    prompt: "runner cutover internal MCP smoke",
    workspaceDir: config.agent.workspace_dir,
    agentSessionId: config.sessionId,
    resolvedMcpServers: config.resolvedMcpServers,
    internalMcpUrl: config.internalMcpUrl,
  } satisfies ClaudeRunOptions, logger);
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

const runtime = new RunnerChildRuntime(config, logger, {
  createEngine: (_config, host) =>
    new ControlledEngine(controlDirectory, config.agent.workspace_dir, host),
});
process.once("SIGTERM", () => { void runtime.shutdown(); });
process.once("SIGINT", () => { void runtime.shutdown(); });
await runtime.start();
await runtime.waitUntilClosed();

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
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

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, JSON.stringify(value), { flag: "wx" });
  await rename(temporaryPath, path);
}
