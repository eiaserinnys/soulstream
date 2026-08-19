import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { Logger } from "pino";

import type { ControlInboxDispatchWork } from "./control_inbox_runtime.js";

type ActiveDispatch = {
  workId: string;
  terminal?:
    | { type: "control_domain_result"; response: Record<string, unknown> }
    | { type: "control_domain_failure"; message: string };
};

export type ControlWorkerMessage =
  | { type: "control_work"; work: ControlInboxDispatchWork }
  | { type: "control_domain_committed"; workId: string }
  | { type: "control_worker_initialized"; stats: Record<string, number> }
  | { type: "control_worker_fatal"; message: string };

export type ControlWorkerBoundary = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: ControlWorkerMessage) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
};

export type ControlChannelServiceOptions = {
  nodeId: string;
  upstreamUrl: string;
  authBearerToken: string;
  runnerStateDir: string;
  logger: Logger;
  dispatchCommand(command: Record<string, unknown>): Promise<void>;
  heartbeatIntervalMs?: number;
  workerFactory?: (workerData: Record<string, unknown>) => ControlWorkerBoundary;
};

export class ControlChannelService {
  private readonly dispatchContext = new AsyncLocalStorage<ActiveDispatch>();
  private readonly activeDispatches = new Map<string, ActiveDispatch>();
  private readonly heartbeatBuffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  private readonly heartbeat = new BigInt64Array(this.heartbeatBuffer);
  private worker: ControlWorkerBoundary | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private activeConnectionId: string | undefined;
  private restartAttempt = 0;
  private stopping = false;

  constructor(private readonly options: ControlChannelServiceOptions) {}

  start(): void {
    if (this.worker) return;
    this.stopping = false;
    this.recordMainHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.recordMainHeartbeat(),
      this.options.heartbeatIntervalMs ?? 100,
    );
    this.spawnWorker();
  }

  activate(connectionId: string): void {
    this.activeConnectionId = connectionId;
    this.worker?.postMessage({ type: "activate", connectionId });
  }

  private spawnWorker(): void {
    if (this.stopping || this.worker) return;
    const workerData = this.workerData();
    const worker = this.options.workerFactory
      ? this.options.workerFactory(workerData)
      : createDefaultWorker(workerData);
    this.worker = worker;
    worker.on("message", (message) => this.handleWorkerMessage(message));
    worker.on("error", (error) => {
      this.options.logger.error({ err: error }, "Control channel worker failed");
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = undefined;
      if (!this.stopping) {
        this.options.logger.error({ code }, "Control channel worker exited unexpectedly");
        const delayMs = Math.min(5_000, 250 * 2 ** this.restartAttempt);
        this.restartAttempt += 1;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          this.spawnWorker();
        }, delayMs);
      }
    });
    if (this.activeConnectionId) {
      worker.postMessage({ type: "activate", connectionId: this.activeConnectionId });
    }
  }

  async sendActiveResult(response: Record<string, unknown>): Promise<void> {
    const active = this.dispatchContext.getStore();
    if (!active) {
      throw new Error("Control domain response emitted outside an active control work item");
    }
    if (active.terminal) {
      this.options.logger.warn(
        { workId: active.workId },
        "Control domain emitted more than one terminal response",
      );
      return;
    }
    active.terminal = { type: "control_domain_result", response };
    this.postTerminal(active);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.heartbeatTimer = undefined;
    this.restartTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    worker.postMessage({ type: "shutdown" });
    await worker.terminate();
  }

  private handleWorkerMessage(message: ControlWorkerMessage): void {
    if (message.type === "control_worker_initialized") {
      this.restartAttempt = 0;
      this.options.logger.info(message.stats, "Control inbox initialized");
      return;
    }
    if (message.type === "control_worker_fatal") {
      this.options.logger.error({ message: message.message }, "Control worker startup failed");
      return;
    }
    if (message.type === "control_domain_committed") {
      this.activeDispatches.delete(message.workId);
      return;
    }
    if (message.type === "control_work") {
      void this.executeWork(message.work);
    }
  }

  private async executeWork(work: ControlInboxDispatchWork): Promise<void> {
    const existing = this.activeDispatches.get(work.workId);
    if (existing) {
      if (existing.terminal) this.postTerminal(existing);
      return;
    }
    const active: ActiveDispatch = { workId: work.workId };
    this.activeDispatches.set(work.workId, active);
    try {
      await this.dispatchContext.run(
        active,
        async () => await this.options.dispatchCommand(work.command),
      );
      if (!active.terminal && !isFireAndForget(work)) {
        throw new Error("Control command handler returned without a terminal response");
      }
    } catch (error) {
      if (!active.terminal) {
        active.terminal = {
          type: "control_domain_failure",
          message: error instanceof Error ? error.message : String(error),
        };
        this.postTerminal(active);
      }
    } finally {
      if (isFireAndForget(work)) this.activeDispatches.delete(work.workId);
    }
  }

  private postTerminal(active: ActiveDispatch): void {
    if (!active.terminal) return;
    this.worker?.postMessage({
      ...active.terminal,
      workId: active.workId,
    });
  }

  private recordMainHeartbeat(): void {
    Atomics.store(this.heartbeat, 0, BigInt(Date.now()));
  }

  private workerData(): Record<string, unknown> {
    return {
      nodeId: this.options.nodeId,
      upstreamUrl: this.options.upstreamUrl,
      authBearerToken: this.options.authBearerToken,
      runnerStateDir: this.options.runnerStateDir,
      heartbeatBuffer: this.heartbeatBuffer,
    };
  }
}

function isFireAndForget(work: ControlInboxDispatchWork): boolean {
  return !work.durable && work.command.type === "subscribe_events";
}

function resolveWorkerEntryUrl(): URL {
  const javascriptCandidates = [
    new URL("./control_inbox_worker_entry.js", import.meta.url),
    new URL("./upstream/control_inbox_worker_entry.js", import.meta.url),
  ];
  for (const candidate of javascriptCandidates) {
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return new URL("./control_inbox_worker_entry.ts", import.meta.url);
}

function createDefaultWorker(workerData: Record<string, unknown>): Worker {
  const entryUrl = resolveWorkerEntryUrl();
  if (entryUrl.pathname.endsWith(".js")) {
    return new Worker(entryUrl, { workerData });
  }
  const source = `
    const { pathToFileURL } = require("node:url");
    import("tsx/esm/api").then(({ tsImport }) =>
      tsImport(${JSON.stringify(entryUrl.href)}, pathToFileURL(process.cwd() + "/").href)
    );
  `;
  return new Worker(source, { eval: true, workerData });
}
