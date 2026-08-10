import { randomUUID } from "node:crypto";

import type { EngineExecuteParams, EnginePort } from "../engine/protocol.js";

import {
  RunnerControlFrameSchema,
  closeCommandFrame,
  engineEventFrame,
  executeCommandFrame,
  interruptCommandFrame,
  parseRunnerCommandJsonRoundTrip,
  prepareSessionCommandFrame,
  runnerCommandResultFrame,
  type RunnerCommandFrame,
  type RunnerCommandResultFrame,
  type RunnerControlFrame,
  type RunnerEventFrame,
} from "./frame_protocol.js";
import { InProcessRunnerFrameChannel } from "./in_process_frame_channel.js";

/**
 * The host-side command boundary for one runner instance.
 *
 * Every lifecycle action enters through `dispatch()`, receives an asynchronous
 * commandId-correlated ACK/error, and uses only JSON-round-tripped DTOs. Phase 3
 * can replace this in-process implementation with an IPC dispatcher without
 * changing Task execution or lifecycle callers.
 */
export interface RunnerCommandDispatcher {
  dispatch(frame: unknown): Promise<RunnerCommandResultFrame>;
  executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame>;
  recoverFrames?(commandId: string): AsyncIterable<RunnerEventFrame>;
  prepareSession(agentSessionId: string): Promise<void>;
  interrupt(): Promise<boolean>;
  close(): Promise<void>;
  detachHost(): Promise<void>;
  sendControlFrame(frame: RunnerControlFrame): Promise<boolean>;
  requestContext(correlationId: string): {
    signal: AbortSignal;
    timeoutMs: number;
  } | undefined;
  waitForSessionAck(): Promise<number | null>;
}

export class InProcessRunnerCommandDispatcher implements RunnerCommandDispatcher {
  private readonly eventStreams = new Map<string, InProcessRunnerFrameChannel>();
  private activeExecuteCommandId: string | undefined;

  constructor(private readonly target: EnginePort) {}

  async dispatch(frame: unknown): Promise<RunnerCommandResultFrame> {
    const commandId = readCommandId(frame);
    let command: RunnerCommandFrame;
    try {
      command = parseRunnerCommandJsonRoundTrip(frame);
    } catch (error) {
      return runnerCommandResultFrame(commandId, {
        status: "error",
        error: { code: "invalid_command", message: errorMessage(error) },
      });
    }

    try {
      switch (command.kind) {
        case "prepare_session":
          await this.target.prepareSessionRuntime?.(command.agentSessionId);
          break;
        case "execute":
          this.startExecution(command);
          break;
        case "interrupt": {
          const interrupted = await this.target.interrupt();
          return runnerCommandResultFrame(command.commandId, {
            status: "ok",
            data: { interrupted },
          });
        }
        case "close":
          await this.target.close();
          break;
        case "invoke": {
          const data = await invokeEngineCapability(
            this.target,
            command.capability,
            command.args,
          );
          return runnerCommandResultFrame(command.commandId, {
            status: "ok",
            ...(data !== undefined ? { data } : {}),
          });
        }
      }
      return runnerCommandResultFrame(command.commandId, { status: "ok" });
    } catch (error) {
      return runnerCommandResultFrame(command.commandId, {
        status: "error",
        error: {
          code: `${command.kind}_failed`,
          message: errorMessage(error),
        },
      });
    }
  }

  executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    const commandId = `execute:${randomUUID()}`;
    const command = executeCommandFrame(commandId, params);
    const result = this.dispatch(command);
    return this.executeCommand(commandId, result);
  }

  async prepareSession(agentSessionId: string): Promise<void> {
    const commandId = `prepare:${agentSessionId}`;
    assertCommandAccepted(await this.dispatch(
      prepareSessionCommandFrame(commandId, agentSessionId),
    ));
  }

  async interrupt(): Promise<boolean> {
    const result = await this.dispatch(interruptCommandFrame(`interrupt:${randomUUID()}`));
    assertCommandAccepted(result);
    return result.result.status === "ok"
      && isRecord(result.result.data)
      && result.result.data.interrupted === true;
  }

  async close(): Promise<void> {
    assertCommandAccepted(await this.dispatch(closeCommandFrame(`close:${randomUUID()}`)));
  }

  async detachHost(): Promise<void> {
    await this.close();
  }

  async sendControlFrame(frame: RunnerControlFrame): Promise<boolean> {
    const parsed = RunnerControlFrameSchema.parse(
      JSON.parse(JSON.stringify(RunnerControlFrameSchema.parse(frame))),
    );
    return await this.target.sendControlFrame?.(parsed) ?? false;
  }

  events(commandId: string): AsyncIterable<RunnerEventFrame> {
    const channel = this.eventStreams.get(commandId);
    if (!channel) {
      throw new Error(`Runner execute command has no event stream: ${commandId}`);
    }
    return this.consumeEventStream(commandId, channel);
  }

  requestContext(correlationId: string): {
    signal: AbortSignal;
    timeoutMs: number;
  } | undefined {
    if (!this.activeExecuteCommandId) return undefined;
    return this.eventStreams.get(this.activeExecuteCommandId)?.requestContext(correlationId);
  }

  async waitForSessionAck(): Promise<number | null> {
    return null;
  }

  private startExecution(command: Extract<RunnerCommandFrame, { kind: "execute" }>): void {
    if (this.activeExecuteCommandId !== undefined) {
      throw new Error(
        `Runner execute command already active: ${this.activeExecuteCommandId}`,
      );
    }
    let channel: InProcessRunnerFrameChannel;
    if (this.target.executeToFrameChannel) {
      channel = new InProcessRunnerFrameChannel();
      channel.start(() => this.target.executeToFrameChannel!(command.params, channel));
    } else if (this.target.executeFrames) {
      const frames = this.target.executeFrames(command.params);
      if (frames instanceof InProcessRunnerFrameChannel) {
        channel = frames;
      } else {
        channel = pipeFrames(frames);
      }
    } else {
      channel = pipeFrames(legacyEngineEventFrames(this.target.execute(command.params)));
    }
    this.eventStreams.set(command.commandId, channel);
    this.activeExecuteCommandId = command.commandId;
  }

  private async *executeCommand(
    commandId: string,
    resultPromise: Promise<RunnerCommandResultFrame>,
  ): AsyncIterable<RunnerEventFrame> {
    const result = await resultPromise;
    assertCommandAccepted(result);
    yield* this.events(commandId);
  }

  private async *consumeEventStream(
    commandId: string,
    channel: InProcessRunnerFrameChannel,
  ): AsyncIterable<RunnerEventFrame> {
    try {
      yield* channel;
    } finally {
      this.eventStreams.delete(commandId);
      if (this.activeExecuteCommandId === commandId) {
        this.activeExecuteCommandId = undefined;
      }
    }
  }
}

export async function invokeEngineCapability(
  target: EnginePort,
  capability: string,
  args: unknown[],
): Promise<unknown> {
  const method = (target as unknown as Record<string, unknown>)[capability];
  if (typeof method !== "function") {
    return { status: "not_supported" };
  }
  return await Reflect.apply(method, target, args);
}

function pipeFrames(frames: AsyncIterable<RunnerEventFrame>): InProcessRunnerFrameChannel {
  const channel = new InProcessRunnerFrameChannel();
  channel.start(async () => {
    for await (const frame of frames) await channel.emit(frame);
  });
  return channel;
}

async function* legacyEngineEventFrames(
  events: AsyncIterable<import("../engine/protocol.js").SSEEventPayload>,
): AsyncIterable<RunnerEventFrame> {
  for await (const event of events) {
    yield engineEventFrame(event);
  }
}

function assertCommandAccepted(frame: RunnerCommandResultFrame): void {
  if (frame.result.status === "ok") return;
  throw new Error(
    `Runner command ${frame.commandId} failed (${frame.result.error.code}): ${frame.result.error.message}`,
  );
}

function readCommandId(frame: unknown): string {
  if (isRecord(frame) && typeof frame.commandId === "string" && frame.commandId.length > 0) {
    return frame.commandId;
  }
  return "invalid-command";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
