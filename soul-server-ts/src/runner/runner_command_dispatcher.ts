import { randomUUID } from "node:crypto";

import type {
  EngineExecuteParams,
  EnginePort,
} from "../engine/protocol.js";
import type { SSEEventInputMaterialManifest } from "@soulstream/wire-schema";
import { stampSessionCost, type SessionCostBase } from "../engine/session_cost.js";
import { engineEventMetadata } from "../engine/engine_event_metadata.js";
import {
  newExecutionCommandId,
  type RunnerExecutionIdentity,
} from "../task/execution_registration.js";
import { currentProcessLockOwner } from "./runner_process_lock.js";

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
import {
  InProcessRunnerFrameChannel,
  type InProcessRunnerFrameChannelOptions,
} from "./in_process_frame_channel.js";
import { isLogicalTurnCompleteFrame } from "./engine_event_stream.js";
import { normalizeRunnerInterventionResult } from "./runner_intervention_result.js";
import {
  RUNNER_INTERVENTION_RECEIPT_CAPABILITY,
  runnerInputInterventionId,
  type RunnerInterventionReceiptPort,
  type RunnerInterventionReceiptVerdict,
} from "./runner_intervention_receipt.js";

const OUTPUT_COMMAND_EVENT_TYPES = new Set([
  "assistant_message",
  "text_start",
  "text_delta",
  "text_end",
  "complete",
]);

/** Capabilities whose first argument is an engine input that may carry a receipt id. */
const INTERVENTION_INPUT_CAPABILITIES = new Set(["intervene", "injectAtToolBoundary"]);

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
  recoverFrames?(
    commandId?: string,
    onPendingFramesReplayed?: () => void,
  ): AsyncIterable<RunnerEventFrame>;
  prepareSession(agentSessionId: string): Promise<void>;
  interrupt(): Promise<boolean>;
  close(): Promise<void>;
  /** Retires durable process registration evidence after the runtime is closed. */
  retireTerminalRegistration?(
    beforeRegistrationRetired?: () => Promise<void>,
  ): Promise<void>;
  detachHost(): Promise<void>;
  releaseEventStreamRegistration?(): Promise<void>;
  /**
   * Gives back every host resource a recovery attempt took on behalf of a task
   * that never adopted it. Unlike `releaseEventStreamRegistration` this also
   * hands back the offline recovery writer lock; leaving it owned by this
   * process made the next spawn terminate the server itself (card #1265).
   */
  releaseUnadoptedRecovery?(): Promise<void>;
  /**
   * Asks the runner that should have received this intervention number whether
   * it did. Only a process runner can answer; an in-process dispatcher has no
   * receipt table, so the node reads a missing method as "unknown".
   */
  lookupInterventionReceipt?(
    interventionId: string,
    expectedRegistrationId: string,
  ): Promise<RunnerInterventionReceiptVerdict>;
  isClosed?(): boolean;
  hasLostRunner?(): boolean;
  /** True only after this process registration reported the exact closed-engine failure. */
  hasClosedEngineFailureForFinalization?(): boolean;
  hasActiveExecution(): boolean;
  activeExecutionCommandId?(): string | undefined;
  dispatcherId?(): string;
  registrationId(): string | undefined;
  sendControlFrame(frame: RunnerControlFrame): Promise<boolean>;
  requestContext(correlationId: string): {
    signal: AbortSignal;
    timeoutMs: number;
  } | undefined;
  waitForSessionAck(): Promise<number | null>;
  prepareExecutionIdentity?(ownerToken?: string): Promise<RunnerExecutionIdentity>;
  rollbackExecutionIdentity?(proof: RunnerExecutionIdentity): Promise<void>;
}

export class InProcessRunnerCommandDispatcher implements RunnerCommandDispatcher {
  private readonly eventStreams = new Map<string, {
    channel: InProcessRunnerFrameChannel;
    params: EngineExecuteParams;
  }>();
  private activeExecuteCommandId: string | undefined;
  private sessionCost: SessionCostBase | undefined;
  private readonly attachedRegistrationId = `in-process:${randomUUID()}`;

  constructor(
    private readonly target: EnginePort,
    private readonly channelOptions: InProcessRunnerFrameChannelOptions = {},
    private readonly interventionReceipts?: RunnerInterventionReceiptPort,
  ) {}

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
        case "execution_status":
          return runnerCommandResultFrame(command.commandId, {
            status: "ok",
            data: { executionCommandId: this.activeExecuteCommandId ?? null },
          });
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
          if (command.capability === RUNNER_INTERVENTION_RECEIPT_CAPABILITY) {
            return runnerCommandResultFrame(command.commandId, {
              status: "ok",
              data: this.readInterventionReceipt(command.args),
            });
          }
          const interventionId = INTERVENTION_INPUT_CAPABILITIES.has(command.capability)
            ? runnerInputInterventionId(command.args[0])
            : undefined;
          if (interventionId) {
            this.interventionReceipts?.recordHanding(
              [interventionId],
              this.activeExecuteCommandId ?? null,
            );
          }
          const data = await invokeEngineCapability(
            this.target,
            command.capability,
            command.args,
          );
          if (interventionId) this.settleInterventionReceipt(interventionId, data);
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

  async prepareExecutionIdentity(ownerToken?: string): Promise<RunnerExecutionIdentity> {
    const observed = await currentProcessLockOwner();
    return {
      registrationId: this.attachedRegistrationId,
      pid: observed.pid,
      startIdentity: observed.startIdentity,
      executionCommandId: ownerToken ?? newExecutionCommandId(),
    };
  }

  registrationId(): string {
    return this.attachedRegistrationId;
  }

  async rollbackExecutionIdentity(_proof: RunnerExecutionIdentity): Promise<void> {
    await this.close();
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

  hasActiveExecution(): boolean {
    return this.activeExecuteCommandId !== undefined;
  }

  activeExecutionCommandId(): string | undefined {
    return this.activeExecuteCommandId;
  }

  async sendControlFrame(frame: RunnerControlFrame): Promise<boolean> {
    const parsed = RunnerControlFrameSchema.parse(
      JSON.parse(JSON.stringify(RunnerControlFrameSchema.parse(frame))),
    );
    return await this.target.sendControlFrame?.(parsed) ?? false;
  }

  events(commandId: string): AsyncIterable<RunnerEventFrame> {
    const execution = this.eventStreams.get(commandId);
    if (!execution) {
      throw new Error(`Runner execute command has no event stream: ${commandId}`);
    }
    return this.consumeEventStream(commandId, execution.channel, execution.params);
  }

  requestContext(correlationId: string): {
    signal: AbortSignal;
    timeoutMs: number;
  } | undefined {
    if (!this.activeExecuteCommandId) return undefined;
    return this.eventStreams.get(this.activeExecuteCommandId)?.channel.requestContext(correlationId);
  }

  async waitForSessionAck(): Promise<number | null> {
    return null;
  }

  private readInterventionReceipt(args: readonly unknown[]): unknown {
    if (!this.interventionReceipts) return { status: "not_supported" };
    const [interventionId] = args;
    if (typeof interventionId !== "string" || interventionId.length === 0) {
      throw new Error(`${RUNNER_INTERVENTION_RECEIPT_CAPABILITY} requires an intervention id`);
    }
    return this.interventionReceipts.lookup(interventionId);
  }

  private settleInterventionReceipt(interventionId: string, data: unknown): void {
    if (!this.interventionReceipts) return;
    const result = normalizeRunnerInterventionResult(data);
    try {
      if (result.status === "delivered") {
        this.interventionReceipts.markApplied([interventionId]);
      } else if (result.status === "not_delivered") {
        this.interventionReceipts.markNotApplied([interventionId]);
      }
    } catch (error) {
      // The engine already answered. A failed receipt update must not change
      // that verdict; the row stays `handing`, which the node reads as unknown.
      warnReceiptWriteFailure([interventionId], error);
    }
  }

  private startExecution(command: Extract<RunnerCommandFrame, { kind: "execute" }>): void {
    if (this.activeExecuteCommandId !== undefined) {
      throw new Error(
        `Runner execute command already active: ${this.activeExecuteCommandId}`,
      );
    }
    const params = bindExecutionCommand(command.commandId, command.params);
    this.interventionReceipts?.recordHanding(
      executionInterventionIds(params),
      command.commandId,
    );
    this.sessionCost = params.sessionCost;
    let channel: InProcessRunnerFrameChannel;
    if (this.target.executeToFrameChannel) {
      channel = new InProcessRunnerFrameChannel(this.channelOptions);
      channel.start(() => this.target.executeToFrameChannel!(params, channel));
    } else if (this.target.executeFrames) {
      const frames = this.target.executeFrames(params);
      if (frames instanceof InProcessRunnerFrameChannel) {
        channel = frames;
      } else {
        channel = pipeFrames(frames, this.channelOptions);
      }
    } else {
      channel = pipeFrames(
        legacyEngineEventFrames(this.target.execute(params)),
        this.channelOptions,
      );
    }
    this.eventStreams.set(command.commandId, { channel, params });
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
    params?: EngineExecuteParams,
  ): AsyncIterable<RunnerEventFrame> {
    const interventionIds = params ? executionInterventionIds(params) : [];
    let executionApplied = false;
    try {
      if (params?.usage_snapshot !== undefined && params.execution_input !== undefined) {
        const manifest: SSEEventInputMaterialManifest = {
          type: "input_material_manifest",
          schema_version: 1,
          timestamp: Date.now() / 1000,
          output_command_id: commandId,
          input_id: params.execution_input.input_id,
          usage_snapshot: params.usage_snapshot,
          execution_input: params.execution_input,
        };
        yield engineEventFrame(manifest);
      }
      for await (const frame of channel) {
        // The first frame from the engine is the point where it accepted the
        // execution input, unless that frame is an error event: a rejection
        // must leave the row `handing` so the node never assumes delivery. A
        // start failure never reaches here either.
        if (!executionApplied && interventionIds.length > 0) {
          executionApplied = true;
          if (!isEngineErrorFrame(frame)) {
            try {
              this.interventionReceipts?.markApplied(interventionIds);
            } catch (error) {
              // A failed receipt update must not cut the event stream.
              warnReceiptWriteFailure(interventionIds, error);
            }
          }
        }
        let eventFrame = frame;
        if (frame.kind === "engine_event") {
          const payload = frame.payload;
          if (this.sessionCost) {
            this.sessionCost = stampSessionCost(payload, this.sessionCost);
          }
          if (typeof payload.type === "string" && (
            OUTPUT_COMMAND_EVENT_TYPES.has(payload.type)
            || payload.type === "result"
            || payload.type === "error"
            || payload.type === "usage_observation"
          )) {
            const inputId = params?.execution_input?.input_id;
            const usageSnapshot = params?.usage_snapshot;
            const hasUsageContext = params?.execution_input !== undefined
              && usageSnapshot !== undefined;
            eventFrame = engineEventFrame({
              ...payload,
              output_command_id: commandId,
              ...(payload.type === "usage_observation" ? { accounting_key: commandId } : {}),
              ...(hasUsageContext
                ? { input_id: inputId ?? null, usage_snapshot: usageSnapshot }
                : {}),
            }, frame.metadata);
          }
        }
        if (
          isLogicalTurnCompleteFrame(eventFrame)
          && this.activeExecuteCommandId === commandId
        ) {
          this.activeExecuteCommandId = undefined;
        }
        yield eventFrame;
      }
    } finally {
      this.eventStreams.delete(commandId);
      if (this.activeExecuteCommandId === commandId) {
        this.activeExecuteCommandId = undefined;
      }
      this.sessionCost = undefined;
    }
  }
}

function executionInterventionIds(params: EngineExecuteParams): string[] {
  const ids: string[] = [];
  if (params.runnerInterventionId) ids.push(params.runnerInterventionId);
  for (const interventionId of params.runnerInterventionIds ?? []) {
    if (!ids.includes(interventionId)) ids.push(interventionId);
  }
  return ids;
}

function bindExecutionCommand(
  commandId: string,
  params: EngineExecuteParams,
): EngineExecuteParams {
  if (params.execution_input === undefined) return params;
  return {
    ...params,
    execution_input: {
      ...params.execution_input,
      command_id: commandId,
    },
  };
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

function pipeFrames(
  frames: AsyncIterable<RunnerEventFrame>,
  options: InProcessRunnerFrameChannelOptions,
): InProcessRunnerFrameChannel {
  const channel = new InProcessRunnerFrameChannel(options);
  channel.start(async () => {
    for await (const frame of frames) await channel.emit(frame);
  });
  return channel;
}

async function* legacyEngineEventFrames(
  events: AsyncIterable<import("../engine/protocol.js").SSEEventPayload>,
): AsyncIterable<RunnerEventFrame> {
  for await (const event of events) {
    // Internal Claude proof travels on non-enumerable Symbols. Copy only the
    // public event fields into the JSON payload and serialize that proof in the
    // explicit runner metadata envelope. Passing the original object causes
    // the strict JSON boundary to drop the whole observational frame.
    yield engineEventFrame({ ...event }, engineEventMetadata(event));
  }
}

function assertCommandAccepted(frame: RunnerCommandResultFrame): void {
  if (frame.result.status === "ok") return;
  throw new Error(
    `Runner command ${frame.commandId} failed (${frame.result.error.code}): ${frame.result.error.message}`,
  );
}

function isEngineErrorFrame(frame: RunnerEventFrame): boolean {
  return frame.kind === "engine_event"
    && isRecord(frame.payload)
    && frame.payload.type === "error";
}

function warnReceiptWriteFailure(
  interventionIds: readonly string[],
  error: unknown,
): void {
  process.emitWarning(
    `runner intervention receipt update failed (${interventionIds.join(", ")}): `
      + errorMessage(error),
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
