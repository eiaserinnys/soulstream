import type { Logger } from "pino";
import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import { runnerProcessPaths } from "../../runner/runner_process_paths.js";
import { engineEventFrame, type RunnerEventFrame } from "../../runner/frame_protocol.js";
import type { InProcessRunnerFrameChannel } from "../../runner/in_process_frame_channel.js";
import { sseEventsFromRunnerFrames } from "../../runner/engine_event_stream.js";
import type {
  EngineExecuteParams,
  EngineInterventionResult,
  EnginePort,
  EngineUserInput,
  SSEEventPayload,
} from "../protocol.js";
import { withScratchWorkspaceEnv } from "../scratch_workspace_env.js";
import { openCodeMcpToolName, prepareOpenCodeSession } from "./config.js";
import { OpenCodeEventMapper, parseOpenCodeEvent } from "./events.js";
import { launchOpenCodeProcess } from "./process.js";

function originalToolName(event: ReturnType<typeof parseOpenCodeEvent>): string | undefined {
  const part = event.part;
  if (!part) return undefined;
  if (part.tool !== "invalid") return part.tool;
  const input = part.state?.input;
  if (!input || typeof input !== "object" || !("tool" in input)
    || typeof input.tool !== "string") return undefined;
  return input.tool;
}

function outOfAllowlistToolName(
  event: ReturnType<typeof parseOpenCodeEvent>,
  allowlist: Record<string, string[]>,
): string | undefined {
  if (event.type !== "tool_use") return undefined;
  const toolName = originalToolName(event);
  if (!toolName) return undefined;
  for (const [serverName, allowedTools] of Object.entries(allowlist)) {
    const serverPrefix = openCodeMcpToolName(serverName, "");
    if (!toolName.startsWith(serverPrefix)) continue;
    if (allowedTools.some((allowed) => openCodeMcpToolName(serverName, allowed) === toolName)) {
      return undefined;
    }
    return toolName;
  }
  return undefined;
}

export interface OpenCodeAdapterOptions {
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

export class OpenCodeEngineAdapter implements EnginePort {
  readonly backendId = "opencode" as const;
  readonly workspaceDir: string;
  private closed = false;
  private executing = false;
  private active?: { process: ReturnType<typeof launchOpenCodeProcess>; cleanedUp: Promise<unknown> };

  constructor(private readonly options: OpenCodeAdapterOptions, private readonly logger: Logger) {
    this.workspaceDir = options.workspaceDir;
  }

  execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    return sseEventsFromRunnerFrames(this.executeFrames(params));
  }

  async executeToFrameChannel(
    params: EngineExecuteParams,
    channel: InProcessRunnerFrameChannel,
  ): Promise<void> {
    for await (const frame of this.executeFrames(params)) await channel.emit(frame);
  }

  async *executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    if (this.closed) throw new Error("OpenCode engine is closed");
    if (this.executing) throw new Error("OpenCode engine already has an active turn");
    this.executing = true;
    const model = params.model || "";
    const mapper = new OpenCodeEventMapper(model);
    const warnedCallIds = new Set<string>();
    let backendSessionId: string | undefined;
    let process: ReturnType<typeof launchOpenCodeProcess> | undefined;
    try {
      if (!this.options.executablePath) {
        throw new Error("OPENCODE_CLI_PATH is required to run the OpenCode backend");
      }
      if (!params.agentSessionId) throw new Error("OpenCode agentSessionId is required");
      if (!model) throw new Error("OpenCode model is required");
      const sessionDirectory = this.options.sessionDirectory
        ?? runnerProcessPaths(this.options.stateDirectory!, params.agentSessionId).sessionDirectory;
      const prepared = await prepareOpenCodeSession({
        workspaceDir: this.workspaceDir,
        model,
        sessionDirectory,
        agentSessionId: params.agentSessionId,
        ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
        ...(params.allowedTools !== undefined ? { allowedTools: params.allowedTools } : {}),
        ...(params.disallowedTools !== undefined ? { disallowedTools: params.disallowedTools } : {}),
        ...(params.useMcp !== undefined ? { useMcp: params.useMcp } : {}),
        ...(params.opencodeMcpToolAllowlist !== undefined
          ? { opencodeMcpToolAllowlist: params.opencodeMcpToolAllowlist }
          : {}),
        ...(this.options.resolvedMcpServers !== undefined
          ? { resolvedMcpServers: this.options.resolvedMcpServers }
          : {}),
        ...(this.options.internalMcpUrl ? { internalMcpUrl: this.options.internalMcpUrl } : {}),
        processEnv: this.options.processEnv,
      });
      const args = ["--print-logs", "--log-level", "ERROR", "run", "--pure", "--format", "json", "--model", model];
      if (params.resumeSessionId) args.push("--session", params.resumeSessionId);
      process = launchOpenCodeProcess({
        executablePath: this.options.executablePath,
        args,
        cwd: this.workspaceDir,
        env: withScratchWorkspaceEnv(prepared.processEnv as Record<string, string>, {
          workspaceDir: this.workspaceDir,
          agentId: this.options.agentId,
        }),
        input: params.prompt,
        logger: this.logger,
      });
      const cleanedUp = process.done;
      this.active = { process, cleanedUp };

      for await (const line of process.events) {
        process.markInitialized();
        try {
          const event = parseOpenCodeEvent(line);
          if (event.sessionID) backendSessionId = event.sessionID;
          const outOfAllowlist = params.opencodeMcpToolAllowlist
            ? outOfAllowlistToolName(event, params.opencodeMcpToolAllowlist)
            : undefined;
          const callID = event.part?.callID;
          if (outOfAllowlist && typeof callID === "string" && !warnedCallIds.has(callID)) {
            warnedCallIds.add(callID);
            this.logger.warn({
              agentId: this.options.agentId,
              agentSessionId: params.agentSessionId,
              backendSessionId,
              toolName: outOfAllowlist,
            }, "OpenCode MCP tool call is outside the configured allowlist");
          }
          for (const mappedEvent of mapper.accept(event)) yield engineEventFrame(mappedEvent);
        } catch (error) {
          for (const event of mapper.fail(error)) yield engineEventFrame(event);
          process.interrupt();
        }
      }
      const exit = await process.done;
      if (exit.error) {
        for (const event of mapper.fail(exit.error)) yield engineEventFrame(event);
      } else {
        for (const event of mapper.finish(exit.code, exit.signal, process.interrupted)) {
          yield engineEventFrame(event);
        }
      }
    } catch (error) {
      if (process) {
        process.interrupt();
        await process.done;
      }
      for (const event of mapper.fail(error)) yield engineEventFrame(event);
    } finally {
      // Keep ownership until close even when the consumer stops reading early.
      if (process) {
        process.interrupt();
        await process.done;
      }
      this.active = undefined;
      this.executing = false;
    }
  }

  async intervene(_input: EngineUserInput): Promise<EngineInterventionResult> {
    if (!await this.interrupt()) {
      return { status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "no_active_turn" };
    }
    return { status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "next_turn_required" };
  }

  async interrupt(): Promise<boolean> {
    return this.active?.process.interrupt() ?? false;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.active) {
      this.active.process.interrupt();
      await this.active.cleanedUp;
    }
  }
}
