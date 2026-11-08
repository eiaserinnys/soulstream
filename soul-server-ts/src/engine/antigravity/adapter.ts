import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import nodeProcess from "node:process";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import { runnerProcessPaths } from "../../runner/runner_process_paths.js";
import { engineEventFrame, type RunnerEventFrame } from "../../runner/frame_protocol.js";
import type { InProcessRunnerFrameChannel } from "../../runner/in_process_frame_channel.js";
import { sseEventsFromRunnerFrames } from "../../runner/engine_event_stream.js";
import type { EngineExecuteParams, EngineInterventionResult, EnginePort, EngineUserInput, SSEEventPayload } from "../protocol.js";
import { withScratchWorkspaceEnv } from "../scratch_workspace_env.js";
import { antigravityMcpGatewayUpstreams, writeAntigravityAgentDefinition, writeAntigravityMcpGatewayConfig } from "./agent_definition.js";
import { antigravityTurnCostUsd } from "../list_price.js";
import {
  addAntigravityUsage,
  AntigravityEventMapper,
  type AntigravityFirstCall,
  type AntigravityUsage,
} from "./events.js";
import { resolveAntigravityMcpGatewayLaunch } from "./mcp_schema_proxy_launch.js";
import { antigravityGatewayServerName } from "./mcp_gateway.js";
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
  private firstCallCarry?: AntigravityFirstCall;

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
    const mapper = new AntigravityEventMapper(randomUUID(), Boolean(params.resumeSessionId), antigravityGatewayServerName(this.options.agentId));
    let definition: Awaited<ReturnType<typeof writeAntigravityAgentDefinition>> | undefined;
    let process: ReturnType<typeof launchAntigravityProcess> | undefined;
    try {
      if (!this.options.executablePath) throw new Error("Antigravity CLI not found; configure AGY_CLI_PATH or install agy on this node");
      if (!params.agentSessionId) throw new Error("Antigravity agentSessionId is required");
      const sessionDirectory = this.options.sessionDirectory ?? runnerProcessPaths(this.options.stateDirectory!, params.agentSessionId).sessionDirectory;
      // Validate effort before writing anything containing session credentials.
      antigravityArguments(params, join(sessionDirectory, "antigravity.log"));
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      const gatewayConfigPath = join(sessionDirectory, "antigravity-mcp-gateway.json");
      if (params.useMcp !== false) {
        await writeAntigravityMcpGatewayConfig(gatewayConfigPath, antigravityMcpGatewayUpstreams({
          resolvedMcpServers: this.options.resolvedMcpServers, useMcp: params.useMcp, logger: this.logger,
        }));
      }
      if (!params.resumeSessionId) {
        if (params.systemPrompt === undefined) throw new Error("이 세션은 첫 턴에서 대화를 만들지 못했습니다. 새 세션을 시작해 주십시오.");
        definition = await writeAntigravityAgentDefinition({
          agentId: this.options.agentId, agentSessionId: params.agentSessionId, systemPrompt: params.systemPrompt, gatewayConfigPath,
          resolvedMcpServers: this.options.resolvedMcpServers, internalMcpUrl: this.options.internalMcpUrl,
          useMcp: params.useMcp, mcpGatewayLaunch: resolveAntigravityMcpGatewayLaunch(import.meta.url, nodeProcess.execPath),
          logger: this.logger,
        });
      }
      process = launchAntigravityProcess({ executablePath: this.options.executablePath,
        args: antigravityArguments(params, join(sessionDirectory, "antigravity.log"), definition),
        cwd: this.workspaceDir,
        env: withScratchWorkspaceEnv(
          Object.fromEntries(Object.entries(this.options.processEnv).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          )),
          { workspaceDir: this.workspaceDir, agentId: this.options.agentId },
        ),
        input: antigravityUserMessage(params.prompt), logger: this.logger,
      });
      const cleanedUp = process.done.then(async () => await definition?.remove());
      this.active = { process, cleanedUp };
      for await (const raw of process.events) for (const event of mapper.accept(raw)) yield engineEventFrame(event);
      const exit = await process.done;
      await cleanedUp;
      const terminalEvents = mapper.terminal(exit, process.interrupted);
      if (terminalEvents.length > 0) {
        const usage = addAntigravityUsage(this.usageCarry, mapper.usage);
        const firstCall = this.firstCallCarry ?? mapper.firstCall ?? undefined;
        this.usageCarry = undefined;
        this.firstCallCarry = undefined;
        for (let i = 0; i < terminalEvents.length; i += 1) {
          const event = terminalEvents[i]!;
          const isLast = i === terminalEvents.length - 1;
          yield engineEventFrame({
            ...event,
            ...(isLast && usage
              ? {
                  usage,
                  ...(firstCall ? { first_call: firstCall } : {}),
                  ...(antigravityTurnCostUsd(usage, mapper.model) !== undefined
                    ? { turn_cost_usd: antigravityTurnCostUsd(usage, mapper.model) }
                    : {}),
                }
              : {}),
          } as SSEEventPayload);
        }
      } else {
        this.usageCarry = addAntigravityUsage(this.usageCarry, mapper.usage);
        this.firstCallCarry ??= mapper.firstCall ?? undefined;
      }
    } catch (error) {
      if (process) { process.interrupt(); await process.done; }
      await definition?.remove();
      const usage = addAntigravityUsage(this.usageCarry, mapper.usage);
      const firstCall = this.firstCallCarry ?? mapper.firstCall ?? undefined;
      this.usageCarry = undefined;
      this.firstCallCarry = undefined;
      yield engineEventFrame({ type: "error", fatal: true,
        message: error instanceof Error ? error.message : String(error), timestamp: Date.now() / 1000,
        ...(mapper.model ? { model: mapper.model } : {}), ...(usage ? { usage } : {}),
        ...(firstCall ? { first_call: firstCall } : {}),
        ...(usage && antigravityTurnCostUsd(usage, mapper.model) !== undefined
          ? { turn_cost_usd: antigravityTurnCostUsd(usage, mapper.model) }
          : {}),
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
