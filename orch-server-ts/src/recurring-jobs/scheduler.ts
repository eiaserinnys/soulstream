import type { NodeRegistryEvent } from "../node/registry_types.js";

import { RecurringJobService } from "./service.js";
import type { RecurringJobRepository, RecurringJobRun } from "./types.js";

export type RecurringJobSchedulerOptions = {
  readonly service: RecurringJobService;
  readonly repository: RecurringJobRepository;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly dueLimit?: number;
  readonly activeLimit?: number;
  readonly onError?: (error: unknown, context: string) => void;
};

/**
 * The recurring scheduler deliberately has no queue or second worker process.
 * A DB reservation is the cross-process ownership boundary; this instance just
 * wakes up, reconciles durable runs, and asks the service to make one attempt.
 */
export class RecurringJobScheduler {
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly dueLimit: number;
  private readonly activeLimit: number;
  private readonly onError: (error: unknown, context: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private reconcileQueued = new Set<string>();
  private reconcilePromise: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: RecurringJobSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 15_000;
    this.dueLimit = options.dueLimit ?? 100;
    this.activeLimit = options.activeLimit ?? 250;
    this.onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    this.stopped = false;
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.drain();
  }

  /**
   * Runtime event sinks must remain synchronous and non-throwing. Only a
   * committed session update can advance an already-created run; a queued
   * reconciliation never emits another create_session request.
   */
  accept(events: readonly NodeRegistryEvent[]): void {
    try {
      for (const event of events) {
        if (event.type !== "node_session_session_updated" || event.committedIngress !== true) continue;
        const sessionId = sessionIdFromEvent(event.data);
        if (sessionId) this.reconcileQueued.add(sessionId);
      }
      this.scheduleEventReconciliation();
    } catch (error) {
      this.report(error, "queue committed recurring session update");
    }
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.running !== undefined) return await this.running;
    this.running = this.tickOnce().finally(() => {
      this.running = undefined;
    });
    return await this.running;
  }

  async drain(): Promise<void> {
    await this.running;
    await this.reconcilePromise;
  }

  private async tickOnce(): Promise<void> {
    try {
      const now = this.now();
      const dueJobs = await this.options.repository.listDueJobs(now, this.dueLimit);
      for (const job of dueJobs) {
        try {
          await this.options.service.reserveAndDispatchDueJob(job);
        } catch (error) {
          this.report(error, `reserve recurring job ${job.jobId}`);
        }
      }
      const activeRuns = await this.options.repository.listActiveRuns(this.activeLimit);
      for (const run of activeRuns) await this.reconcileActiveRun(run);
      await this.flushQueuedReconciliations();
    } catch (error) {
      this.report(error, "tick recurring jobs");
    }
  }

  private scheduleEventReconciliation(): void {
    if (this.reconcilePromise !== undefined || this.stopped) return;
    this.reconcilePromise = Promise.resolve()
      .then(async () => await this.flushQueuedReconciliations())
      .catch((error) => this.report(error, "reconcile committed recurring session update"))
      .finally(() => {
        this.reconcilePromise = undefined;
        if (this.reconcileQueued.size > 0 && !this.stopped) this.scheduleEventReconciliation();
      });
  }

  private async flushQueuedReconciliations(): Promise<void> {
    while (this.reconcileQueued.size > 0) {
      const sessionIds = [...this.reconcileQueued];
      this.reconcileQueued.clear();
      for (const sessionId of sessionIds) {
        try {
          await this.options.service.reconcileSession(sessionId);
        } catch (error) {
          this.report(error, `reconcile recurring session ${sessionId}`);
        }
      }
    }
  }

  private async reconcileActiveRun(run: RecurringJobRun): Promise<void> {
    if (run.state === "queued" || run.state === "waiting_for_node") {
      const job = await this.options.repository.getJob(run.jobId);
      if (job) await this.options.service.dispatchRun(job, run);
      return;
    }
    await this.options.service.reconcileSession(run.sessionId);
  }

  private report(error: unknown, context: string): void {
    try {
      this.onError(error, context);
    } catch {
      // Error reporting must never break a node WebSocket event sink.
    }
  }
}

function sessionIdFromEvent(data: Record<string, unknown>): string | undefined {
  const nested = data.session;
  const values = [
    data.agentSessionId,
    data.agent_session_id,
    data.sessionId,
    data.session_id,
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).agentSessionId ??
        (nested as Record<string, unknown>).agent_session_id ??
        (nested as Record<string, unknown>).sessionId ??
        (nested as Record<string, unknown>).session_id
      : undefined,
  ];
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
