import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import { runnerProcessPaths } from "../../runner/runner_process_paths.js";
import { engineEventFrame, type RunnerEventFrame } from "../../runner/frame_protocol.js";
import type { InProcessRunnerFrameChannel } from "../../runner/in_process_frame_channel.js";
import { sseEventsFromRunnerFrames } from "../../runner/engine_event_stream.js";
import type { EngineExecuteParams, EngineInterventionResult, EnginePort, EngineUserInput, SSEEventPayload } from "../protocol.js";
import { writeAntigravityAgentDefinition } from "./agent_definition.js";
import { addAntigravityUsage, AntigravityEventMapper, type AntigravityUsage } from "./events.js";
import { antigravityArguments, antigravityUserMessage } from "./params.js";
import { launchAntigravityProcess } from "./process.js";

export interface AntigravityAdapterOptions {
  workspaceDir: string;
  agentId: string;
  /** Child runner already knows its session directory. In-process callers pass the state root. */
  sessionDirectory?: string;
  stateDirectory?: string;
  executablePath?: string;
  processEnv: NodeJS.ProcessEnv;
  resolvedMcpServers?: ResolvedMcpServer[];
  internalMcpUrl?: string;
}

export class AntigravityEngineAdapter implements EnginePort {
  readonly backendId = "antigravity" as const;
  readonly workspaceDir: string;
  private closed = false;
  private executing = false;
  private active?: { process: ReturnType<typeof launchAntigravityProcess>; cleanedUp: Promise<unknown> };
  private usageCarry?: AntigravityUsage;

  constructor(private readonly options: AntigravityAdapterOptions, private readonly logger: Logger) {
    this.workspaceDir = options.workspaceDir;
  }

  execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    return sseEventsFromRunnerFrames(this.executeFrames(params));
  }

  async executeToFrameChannel(params: EngineExecuteParams, channel: InProcessRunnerFrameChannel): Promise<void> {
    for await (const frame of this.executeFrames(params)) await channel.emit(frame);
  }

  async *executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    if (this.closed) throw new Error("Antigravity engine is closed");
    if (this.executing) throw new Error("Antigravity engine already has an active turn");
    this.executing = true;
    const mapper = new AntigravityEventMapper(randomUUID());
    let definition: Awaited<ReturnType<typeof writeAntigravityAgentDefinition>> | undefined;
    let process: ReturnType<typeof launchAntigravityProcess> | undefined;
    try {
      if (!this.options.executablePath) throw new Error("Antigravity CLI not found; configure AGY_CLI_PATH or install agy on this node");
      if (!params.agentSessionId) throw new Error("Antigravity agentSessionId is required");
      const sessionDirectory = this.options.sessionDirectory ?? runnerProcessPaths(this.options.stateDirectory!, params.agentSessionId).sessionDirectory;
      // Validate effort before writing anything containing session credentials.
      antigravityArguments(params, join(sessionDirectory, "antigravity.log"));
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      if (!params.resumeSessionId) {
        if (params.systemPrompt === undefined) throw new Error("이 세션은 첫 턴에서 대화를 만들지 못했습니다. 새 세션을 시작해 주십시오.");
        definition = await writeAntigravityAgentDefinition({
          agentSessionId: params.agentSessionId, systemPrompt: params.systemPrompt,
          resolvedMcpServers: this.options.resolvedMcpServers, internalMcpUrl: this.options.internalMcpUrl,
          useMcp: params.useMcp, logger: this.logger,
        });
      }
      process = launchAntigravityProcess({ executablePath: this.options.executablePath,
        args: antigravityArguments(params, join(sessionDirectory, "antigravity.log"), definition),
        cwd: this.workspaceDir, env: this.options.processEnv, input: antigravityUserMessage(params.prompt), logger: this.logger,
      });
      const cleanedUp = process.done.then(async () => await definition?.remove());
      this.active = { process, cleanedUp };
      for await (const raw of process.events) for (const event of mapper.accept(raw)) yield engineEventFrame(event);
      const exit = await process.done;
      await cleanedUp;
      const terminal = mapper.terminal(exit, process.interrupted);
      if (terminal) {
        const usage = addAntigravityUsage(this.usageCarry, mapper.usage);
        this.usageCarry = undefined;
        yield engineEventFrame({ ...terminal, ...(usage ? { usage } : {}) } as SSEEventPayload);
      } else {
        this.usageCarry = addAntigravityUsage(this.usageCarry, mapper.usage);
      }
    } catch (error) {
      if (process) { process.interrupt(); await process.done; }
      await definition?.remove();
      const usage = addAntigravityUsage(this.usageCarry, mapper.usage);
      this.usageCarry = undefined;
      yield engineEventFrame({ type: "error", fatal: true,
        message: error instanceof Error ? error.message : String(error), timestamp: Date.now() / 1000,
        ...(mapper.model ? { model: mapper.model } : {}), ...(usage ? { usage } : {}),
      });
    } finally {
      // If a frame consumer stops early, keep ownership until the CLI closes.
      if (process) { process.interrupt(); await process.done; }
      await definition?.remove();
      this.active = undefined;
      this.executing = false;
    }
  }

  async intervene(_input: EngineUserInput): Promise<EngineInterventionResult> {
    if (!await this.interrupt()) return { status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "no_active_turn" };
    return { status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "next_turn_required" };
  }

  async interrupt(): Promise<boolean> { return this.active?.process.interrupt() ?? false; }

  async close(): Promise<void> {
    this.closed = true;
    if (this.active) {
      this.active.process.interrupt();
      await this.active.cleanedUp;
    }
  }
}
