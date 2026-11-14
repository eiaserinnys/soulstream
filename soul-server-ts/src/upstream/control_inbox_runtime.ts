import { performance } from "node:perf_hooks";

import {
  boundedResultTimeoutMs,
  controlCommandPolicy,
  type ControlCommandFamily,
} from "./control_command_inventory.js";
import { type AckSample, recordAckSample } from "./control_ack_metrics.js";
import { completeDurableWork, UncommittedWorkRedispatch } from "./control_inbox_complete.js";
import type {
  ControlInboxAdmission,
  ControlInboxResult,
  ControlInboxStore,
  ControlInboxWork,
} from "./control_inbox_store.js";

const DEFAULT_LEASE_MS = 30_000;
// Leave scheduler/send headroom beneath the externally observed one-second max.
const DEFAULT_BOUNDED_RESULT_TIMEOUT_MS = 900;
const HEALTHY_HEARTBEAT_AGE_MS = 250;
const AVAILABLE_HEARTBEAT_AGE_MS = 1_000;

export interface ControlInboxStorage {
  initialize(): {
    reclaimed: number;
    pruned: number;
    pending: number;
    replayableResults: number;
  };
  admit(
    commandFamily: ControlCommandFamily,
    command: Record<string, unknown>,
  ): ControlInboxAdmission;
  claimPending(options: { leaseMs: number; limit: number }): ControlInboxWork[];
  /** lease가 끝난 claimed 작업을 pending으로 되돌린다. 되돌린 수를 준다. */
  reclaimExpired(): number;
  complete(
    work: ControlInboxWork,
    response: Record<string, unknown>,
    state?: "completed" | "rejected",
  ): ControlInboxResult;
  listReplayableResults(): ControlInboxResult[];
  acknowledgeResult(resultId: string): boolean;
  close(): void;
}

export type ControlInboxDispatchWork = {
  workId: string;
  command: Record<string, unknown>;
  commandFamily: ControlCommandFamily;
  durable: boolean;
};

export type ControlInboxRuntimeOptions = {
  store: ControlInboxStorage | ControlInboxStore;
  nodeId: string;
  mainHeartbeatAgeMs(): number;
  postWork(work: ControlInboxDispatchWork): void;
  onDurableCommit?(workId: string): void;
  leaseMs?: number;
  boundedResultTimeoutMs?: number;
  nowEpochMs?: () => number;
  nowMonoMs?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  clearScheduled?: (handle: unknown) => void;
  /** Reports a reply that was dropped because the control connection was gone. */
  log?(message: string, fields: Record<string, unknown>): void;
};

type RuntimeWork = {
  dispatch: ControlInboxDispatchWork;
  receivedAtMonoMs: number;
  requestId: string;
  durableWork?: ControlInboxWork;
  timeoutHandle?: unknown;
};

export class ControlInboxRuntime {
  private readonly store: ControlInboxStorage;
  private readonly nowEpochMs: () => number;
  private readonly nowMonoMs: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly clearScheduled: (handle: unknown) => void;
  private readonly activeWork = new Map<string, RuntimeWork>();
  private readonly ackSamples = new Map<ControlCommandFamily, AckSample[]>();
  private sendFrame: ((frame: Record<string, unknown>) => Promise<void>) | undefined;
  private workSequence = 0;
  private readonly uncommitted: UncommittedWorkRedispatch;

  constructor(private readonly options: ControlInboxRuntimeOptions) {
    this.store = options.store;
    this.nowEpochMs = options.nowEpochMs ?? Date.now;
    this.nowMonoMs = options.nowMonoMs ?? performance.now.bind(performance);
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearScheduled = options.clearScheduled ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.uncommitted = new UncommittedWorkRedispatch({
      schedule: this.schedule, clearScheduled: this.clearScheduled, nowEpochMs: this.nowEpochMs,
      isConnected: () => this.sendFrame !== undefined, redispatch: () => this.dispatchPending(), log: options.log,
    });
  }

  initialize(): ReturnType<ControlInboxStorage["initialize"]> {
    return this.store.initialize();
  }

  async connect(
    sendFrame: (frame: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    this.sendFrame = sendFrame;
    await this.replayResults();
    this.dispatchPending();
    this.uncommitted.reschedule();
  }

  disconnect(): void {
    this.sendFrame = undefined;
  }

  async handleCommand(command: Record<string, unknown>): Promise<void> {
    const receivedAtMonoMs = this.nowMonoMs();
    const commandType = stringField(command.type);
    const requestId = stringField(command.requestId ?? command.request_id);
    if (!commandType) {
      await this.sendError({
        family: "session",
        requestId,
        receivedAtMonoMs,
        code: "CONTROL_COMMAND_TYPE_REQUIRED",
        message: "Control command requires type",
        status: "rejected",
      });
      return;
    }

    let inventory;
    try {
      inventory = controlCommandPolicy(commandType);
    } catch (error) {
      await this.sendError({
        family: "session",
        requestId,
        receivedAtMonoMs,
        code: "CONTROL_COMMAND_NOT_IN_INVENTORY",
        message: error instanceof Error ? error.message : String(error),
        status: "rejected",
      });
      return;
    }

    if (inventory.policy === "health") {
      const heartbeatAgeMs = Math.max(0, this.options.mainHeartbeatAgeMs());
      const status = heartbeatAgeMs <= HEALTHY_HEARTBEAT_AGE_MS
        ? "healthy"
        : heartbeatAgeMs <= AVAILABLE_HEARTBEAT_AGE_MS
          ? "degraded"
          : "unavailable";
      await this.sendAck(inventory.family, receivedAtMonoMs, {
        type: "health_status",
        requestId,
        node_id: this.options.nodeId,
        status,
        mainHeartbeatAgeMs: heartbeatAgeMs,
      });
      return;
    }

    if (inventory.policy === "fire_and_forget") {
      this.options.postWork({
        workId: this.nextWorkId("fire-and-forget"),
        command,
        commandFamily: inventory.family,
        durable: false,
      });
      return;
    }

    if (!requestId) {
      await this.sendError({
        family: inventory.family,
        requestId,
        receivedAtMonoMs,
        code: "CONTROL_REQUEST_ID_REQUIRED",
        message: `${commandType} requires requestId`,
        status: "rejected",
      });
      return;
    }

    if (inventory.policy === "durable_mutation") {
      let admission;
      try {
        admission = this.store.admit(inventory.family, command);
      } catch (error) {
        await this.sendError({
          family: inventory.family,
          requestId,
          receivedAtMonoMs,
          code: "CONTROL_INBOX_DEGRADED",
          message: error instanceof Error ? error.message : String(error),
          status: "rejected",
        });
        return;
      }
      if (admission.status === "conflict") {
        await this.sendError({
          family: inventory.family,
          requestId,
          receivedAtMonoMs,
          code: "CONTROL_PAYLOAD_CONFLICT",
          message: "requestId is already committed with a different payload",
          status: "rejected",
        });
        return;
      }
      await this.sendAck(inventory.family, receivedAtMonoMs, {
        type: "control_admission_ack",
        requestId,
        commandType,
        commandFamily: inventory.family,
        status: admission.status,
        durability: "control_inbox_sqlite",
      });
      this.dispatchPending();
      if (admission.state === "completed" || admission.state === "rejected") {
        await this.replayResults();
      }
      return;
    }

    const workId = this.nextWorkId("bounded");
    const runtimeWork: RuntimeWork = {
      dispatch: {
        workId,
        command,
        commandFamily: inventory.family,
        durable: false,
      },
      receivedAtMonoMs,
      requestId,
    };
    runtimeWork.timeoutHandle = this.schedule(() => {
      if (this.activeWork.get(workId) !== runtimeWork) return;
      this.activeWork.delete(workId);
      void this.sendBestEffort(
        () => this.sendError({
          family: inventory.family,
          requestId,
          receivedAtMonoMs,
          code: "CONTROL_RESULT_TIMEOUT",
          message: `${commandType} did not produce a result within the bounded deadline`,
          status: "degraded",
        }),
        { kind: "bounded_timeout", commandType, requestId },
      );
    }, boundedResultTimeoutMs(
      commandType,
      this.options.boundedResultTimeoutMs ?? DEFAULT_BOUNDED_RESULT_TIMEOUT_MS,
    ));
    this.activeWork.set(workId, runtimeWork);
    try {
      this.options.postWork(runtimeWork.dispatch);
    } catch (error) {
      this.clearWork(runtimeWork);
      await this.sendError({
        family: inventory.family,
        requestId,
        receivedAtMonoMs,
        code: "CONTROL_EXECUTOR_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
        status: "degraded",
      });
    }
  }

  async handleDomainResult(
    workId: string,
    response: Record<string, unknown>,
  ): Promise<boolean> {
    const runtimeWork = this.activeWork.get(workId);
    if (!runtimeWork) return false;
    this.clearWork(runtimeWork);
    if (runtimeWork.durableWork) {
      // 완료를 못 적으면 작업을 열어 두고 오류를 올린다. 다시 온 결과는 여기서 다시 완료되고 도메인
      // 효과는 되풀이되지 않는다(control_channel_service의 활성 작업 중복 막기).
      const { store, schedule } = this;
      const work = runtimeWork.durableWork;
      const result = await completeDurableWork({
        store, schedule, response, work, log: this.options.log,
      }).catch((error: unknown) => {
        this.activeWork.set(workId, runtimeWork);
        this.uncommitted.markFailed(workId, work.leaseExpiresAt);
        throw error;
      });
      this.uncommitted.committed(workId);
      this.options.onDurableCommit?.(workId);
      try {
        await this.sendResult(result);
      } catch {
        // SQLite completion is canonical. A broken control socket replays this
        // unacknowledged result after reconnect; domain execution must not repeat.
      }
      return true;
    }
    await this.sendBestEffort(
      () => this.sendAck(
        runtimeWork.dispatch.commandFamily,
        runtimeWork.receivedAtMonoMs,
        { ...response, requestId: runtimeWork.requestId },
      ),
      { kind: "bounded_result", workId, requestId: runtimeWork.requestId },
    );
    return true;
  }

  async handleDomainFailure(workId: string, error: unknown): Promise<boolean> {
    const runtimeWork = this.activeWork.get(workId);
    if (!runtimeWork) return false;
    return await this.handleDomainResult(workId, {
      type: "error",
      requestId: runtimeWork.requestId,
      status: "error",
      code: "CONTROL_DOMAIN_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  acknowledgeResult(resultId: string): boolean {
    return this.store.acknowledgeResult(resultId);
  }

  close(): void {
    this.uncommitted.cancel();
    for (const work of this.activeWork.values()) this.clearWork(work);
    this.activeWork.clear();
    this.store.close();
    this.sendFrame = undefined;
  }

  private dispatchPending(): void {
    // lease가 끝난 채 남은 claimed(완료 기록 실패 등)를 다시 집을 수 있게 되돌린다.
    this.store.reclaimExpired();
    while (true) {
      const claimed = this.store.claimPending({
        leaseMs: this.options.leaseMs ?? DEFAULT_LEASE_MS,
        limit: 100,
      });
      for (const durableWork of claimed) {
        const workId = durableWorkId(durableWork);
        const runtimeWork: RuntimeWork = {
          dispatch: {
            workId,
            command: durableWork.command,
            commandFamily: durableWork.commandFamily,
            durable: true,
          },
          receivedAtMonoMs: this.nowMonoMs(),
          requestId: durableWork.requestId,
          durableWork,
        };
        this.activeWork.set(workId, runtimeWork);
        this.uncommitted.refreshLease(workId, durableWork.leaseExpiresAt);
        try {
          this.options.postWork(runtimeWork.dispatch);
        } catch (error) {
          void this.handleDomainFailure(workId, error);
        }
      }
      if (claimed.length < 100) return;
    }
  }

  private async replayResults(): Promise<void> {
    if (!this.sendFrame) return;
    for (const result of this.store.listReplayableResults()) {
      await this.sendResult(result);
    }
  }

  private async sendResult(result: ControlInboxResult): Promise<void> {
    if (!this.sendFrame) return;
    await this.sendFrame({
      type: "control_result",
      resultId: result.resultId,
      nodeId: result.nodeId,
      commandFamily: result.commandFamily,
      requestId: result.requestId,
      state: result.state,
      response: result.response,
    });
  }

  /**
   * Sends a reply to a bounded query whose answer only matters on the connection that asked.
   * With no connection (disconnected, or the socket closing mid-send) the reply has nowhere to
   * go: it is dropped with one log line. Throwing here reached the worker thread as an
   * unhandled rejection and killed it (card #1266 U6). Durable results are not sent through
   * this path; they replay after reconnect.
   */
  private async sendBestEffort(
    send: () => Promise<void>,
    context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.sendFrame) {
      this.options.log?.("control reply dropped: control channel is not connected", context);
      return;
    }
    try {
      await send();
    } catch (error) {
      this.options.log?.("control reply dropped: send failed", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendError(input: {
    family: ControlCommandFamily;
    requestId: string;
    receivedAtMonoMs: number;
    code: string;
    message: string;
    status: "rejected" | "degraded";
  }): Promise<void> {
    await this.sendAck(input.family, input.receivedAtMonoMs, {
      type: "error",
      requestId: input.requestId,
      status: input.status,
      code: input.code,
      message: input.message,
    });
  }

  private async sendAck(
    family: ControlCommandFamily,
    receivedAtMonoMs: number,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const send = this.requireSender();
    await send(frame);
    const durationMs = Math.max(0, this.nowMonoMs() - receivedAtMonoMs);
    const metric = this.recordAck(family, durationMs);
    try {
      await send({
        type: "control_ack_metric",
        nodeId: this.options.nodeId,
        commandFamily: family,
        ...metric,
      });
    } catch {
      // The ACK is already delivered. Observability must not strand a durable
      // receipt or turn successful bounded work into a protocol failure.
    }
  }

  private recordAck(
    family: ControlCommandFamily,
    durationMs: number,
  ): Record<string, unknown> {
    const samples = this.ackSamples.get(family) ?? [];
    this.ackSamples.set(family, samples);
    return recordAckSample(samples, this.nowEpochMs(), durationMs);
  }

  private clearWork(work: RuntimeWork): void {
    this.activeWork.delete(work.dispatch.workId);
    if (work.timeoutHandle !== undefined) this.clearScheduled(work.timeoutHandle);
  }

  private nextWorkId(kind: string): string {
    this.workSequence += 1;
    return `${kind}:${this.options.nodeId}:${this.workSequence}`;
  }

  private requireSender(): (frame: Record<string, unknown>) => Promise<void> {
    if (!this.sendFrame) throw new Error("Control channel is not connected");
    return this.sendFrame;
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function durableWorkId(work: ControlInboxWork): string {
  return [
    "durable",
    work.nodeId,
    work.commandFamily,
    work.requestId,
    work.payloadHash,
  ].join(":");
}
