import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import nodeProcess from "node:process";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import type { ModelCatalogConfig } from "../../model_catalog.js";
import { runnerProcessPaths } from "../../runner/runner_process_paths.js";
import { engineEventFrame, type RunnerEventFrame } from "../../runner/frame_protocol.js";
import type { InProcessRunnerFrameChannel } from "../../runner/in_process_frame_channel.js";
import { sseEventsFromRunnerFrames } from "../../runner/engine_event_stream.js";
import type {
  ClaudePermissionMode,
  EngineExecuteParams,
  EngineInterventionResult,
  EnginePort,
  EngineUserInput,
  SSEEventPayload,
} from "../protocol.js";
import { withScratchWorkspaceEnv } from "../scratch_workspace_env.js";
import { antigravityMcpGatewayUpstreams, writeAntigravityAgentDefinition, writeAntigravityMcpGatewayConfig } from "./agent_definition.js";
import { antigravityTurnCostUsd } from "../list_price.js";
import {
  addAntigravityUsage,
  AntigravityEventMapper,
  type AntigravityFirstCall,
  type AntigravityUsage,
  type AntigravityGenerationUsage,
} from "./events.js";
import { resolveAntigravityMcpGatewayLaunch } from "./mcp_schema_proxy_launch.js";
import { antigravityGatewayServerName } from "./mcp_gateway.js";
import { antigravityArguments, antigravityUserMessage } from "./params.js";
import { launchAntigravityProcess } from "./process.js";
import { materializeAntigravityRestrictedBundle, writeAntigravityRestrictedBundle } from "./restricted_bundle.js";

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
  /** Effective tool policy carried by the engine factory; turn parameters take precedence. */
  allowedTools?: string[];
  disallowedTools?: string[];
  claudePermissionMode?: ClaudePermissionMode;
  /** Profile workspace whose `.claude/agents/*.md` become agy subagent definitions. */
  profileWorkspaceDir?: string;
  /** Latest catalogue snapshot; read once per terminal event. */
  getModelCatalog?: () => ModelCatalogConfig;
}

export class AntigravityEngineAdapter implements EnginePort {
  readonly backendId = "antigravity" as const;
  readonly workspaceDir: string;
  private closed = false;
  private executing = false;
  private active?: { process: ReturnType<typeof launchAntigravityProcess>; cleanedUp: Promise<unknown> };
  private usageCarry?: AntigravityUsage;
  private firstCallCarry?: AntigravityFirstCall;
  private generationUsageCarry?: AntigravityGenerationUsage;
  private lastContextCarry?: number;
  private nativeSessionCarry?: string;
  private resumeStructureCarry?: boolean;

  private mergeGenerationUsage(mapper: AntigravityEventMapper, resumeStructure: boolean): AntigravityGenerationUsage | undefined {
    const previous = this.generationUsageCarry;
    const current = mapper.generationUsage;
    if (!previous && current.model_call_count === 0) return undefined;
    const connected = previous && this.nativeSessionCarry !== undefined
      && this.nativeSessionCarry === mapper.nativeSessionId
      && this.resumeStructureCarry === true && resumeStructure
      && this.lastContextCarry !== undefined && mapper.firstContextTokens !== undefined
      && mapper.firstContextTokens >= this.lastContextCarry;
    return {
      model_call_count: (previous?.model_call_count ?? 0) + current.model_call_count,
      context_growth_tokens: (previous?.context_growth_tokens ?? 0) + current.context_growth_tokens
        + (connected ? mapper.firstContextTokens! - this.lastContextCarry! : 0),
      context_growth_samples: (previous?.context_growth_samples ?? 0) + current.context_growth_samples
        + (connected ? 1 : 0),
    };
  }

  private clearGenerationCarry(): void {
    this.generationUsageCarry = undefined;
    this.lastContextCarry = undefined;
    this.nativeSessionCarry = undefined;
    this.resumeStructureCarry = undefined;
  }

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
    const resumeStructure = Boolean(params.resumeSessionId) && params.systemPrompt === undefined;
    const mapper = new AntigravityEventMapper(
      randomUUID(),
      Boolean(params.resumeSessionId),
      antigravityGatewayServerName(this.options.agentId),
      this.options.getModelCatalog,
    );
    let agentSelection: { name: string } | undefined;
    let removeDefinitions: (() => Promise<void>) | undefined;
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
      const effectiveAllowedTools = params.allowedTools ?? this.options.allowedTools;
      const effectivePermissionMode = params.claudePermissionMode ?? this.options.claudePermissionMode;
      const restrictedAllowedTools = effectivePermissionMode === "dontAsk" && Array.isArray(effectiveAllowedTools)
        ? effectiveAllowedTools
        : undefined;
      if (restrictedAllowedTools) {
        const policyDirectory = join(sessionDirectory, "antigravity-tool-policy");
        if (!params.resumeSessionId) {
          if (params.systemPrompt === undefined) throw new Error("이 세션은 첫 턴에서 대화를 만들지 못했습니다. 새 세션을 시작해 주십시오.");
          const bundle = await writeAntigravityRestrictedBundle({
            directory: policyDirectory,
            agentId: this.options.agentId,
            agentSessionId: params.agentSessionId,
            systemPrompt: params.systemPrompt,
            gatewayConfigPath,
            resolvedMcpServers: this.options.resolvedMcpServers,
            internalMcpUrl: this.options.internalMcpUrl,
            useMcp: params.useMcp,
            mcpGatewayLaunch: resolveAntigravityMcpGatewayLaunch(import.meta.url, nodeProcess.execPath),
            allowedTools: restrictedAllowedTools,
            disallowedTools: params.disallowedTools ?? this.options.disallowedTools,
            profileWorkspaceDir: this.options.profileWorkspaceDir ?? this.options.workspaceDir,
            logger: this.logger,
          });
          agentSelection = { name: bundle.mainName };
        }
        const materialized = await materializeAntigravityRestrictedBundle(policyDirectory);
        removeDefinitions = materialized.remove;
      } else if (!params.resumeSessionId) {
        if (params.systemPrompt === undefined) throw new Error("이 세션은 첫 턴에서 대화를 만들지 못했습니다. 새 세션을 시작해 주십시오.");
        const written = await writeAntigravityAgentDefinition({
          agentId: this.options.agentId, agentSessionId: params.agentSessionId, systemPrompt: params.systemPrompt, gatewayConfigPath,
          resolvedMcpServers: this.options.resolvedMcpServers, internalMcpUrl: this.options.internalMcpUrl,
          useMcp: params.useMcp, mcpGatewayLaunch: resolveAntigravityMcpGatewayLaunch(import.meta.url, nodeProcess.execPath),
          logger: this.logger,
        });
        agentSelection = { name: written.name };
        removeDefinitions = written.remove;
      }
      process = launchAntigravityProcess({ executablePath: this.options.executablePath,
        args: antigravityArguments(params, join(sessionDirectory, "antigravity.log"), agentSelection),
        cwd: this.workspaceDir,
        env: withScratchWorkspaceEnv(
          Object.fromEntries(Object.entries(this.options.processEnv).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          )),
          { workspaceDir: this.workspaceDir, agentId: this.options.agentId },
        ),
        input: antigravityUserMessage(params.prompt), logger: this.logger,
      });
      const cleanedUp = process.done.then(async () => await removeDefinitions?.());
      this.active = { process, cleanedUp };
      for await (const raw of process.events) for (const event of mapper.accept(raw)) yield engineEventFrame(event);
      const exit = await process.done;
      await cleanedUp;
      const terminalEvents = mapper.terminal(exit, process.interrupted);
      const generationUsage = this.mergeGenerationUsage(mapper, resumeStructure);
      if (terminalEvents.length > 0) {
        const usage = addAntigravityUsage(this.usageCarry, mapper.usage);
        const firstCall = this.firstCallCarry ?? mapper.firstCall ?? undefined;
        this.usageCarry = undefined;
        this.firstCallCarry = undefined;
        this.clearGenerationCarry();
        const catalog = this.options.getModelCatalog?.();
        const turnCostUsd = usage && catalog
          ? antigravityTurnCostUsd(catalog, usage, mapper.model)
          : undefined;
        for (let i = 0; i < terminalEvents.length; i += 1) {
          const event = terminalEvents[i]!;
          const isLast = i === terminalEvents.length - 1;
          yield engineEventFrame({
            ...event,
            ...(isLast && usage
              ? {
                  usage,
                  ...(firstCall ? { first_call: firstCall } : {}),
                  ...(turnCostUsd !== undefined ? { turn_cost_usd: turnCostUsd } : {}),
                }
              : {}),
            ...(isLast && generationUsage ? { generation_usage: generationUsage } : {}),
          } as SSEEventPayload);
        }
      } else {
        this.usageCarry = addAntigravityUsage(this.usageCarry, mapper.usage);
        this.firstCallCarry ??= mapper.firstCall ?? undefined;
        this.generationUsageCarry = generationUsage;
        if (mapper.lastContextTokens > 0) {
          this.lastContextCarry = mapper.lastContextTokens;
          this.nativeSessionCarry = mapper.nativeSessionId;
          this.resumeStructureCarry = resumeStructure;
        }
      }
    } catch (error) {
      if (process) { process.interrupt(); await process.done; }
      await removeDefinitions?.();
      const usage = addAntigravityUsage(this.usageCarry, mapper.usage);
      const firstCall = this.firstCallCarry ?? mapper.firstCall ?? undefined;
      const generationUsage = this.mergeGenerationUsage(mapper, resumeStructure);
      this.usageCarry = undefined;
      this.firstCallCarry = undefined;
      this.clearGenerationCarry();
      const catalog = this.options.getModelCatalog?.();
      const turnCostUsd = usage && catalog
        ? antigravityTurnCostUsd(catalog, usage, mapper.model)
        : undefined;
      yield engineEventFrame({ type: "error", fatal: true,
        message: error instanceof Error ? error.message : String(error), timestamp: Date.now() / 1000,
        ...(mapper.model ? { model: mapper.model } : {}), ...(usage ? { usage } : {}),
        ...(firstCall ? { first_call: firstCall } : {}),
        ...(generationUsage ? { generation_usage: generationUsage } : {}),
        ...(turnCostUsd !== undefined ? { turn_cost_usd: turnCostUsd } : {}),
      });
    } finally {
      // If a frame consumer stops early, keep ownership until the CLI closes.
      if (process) { process.interrupt(); await process.done; }
      await removeDefinitions?.();
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
