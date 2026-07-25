import type { Logger } from "pino";

import type { ClaudeClient } from "./claude_adapter.js";
import type {
  ClaudeBackgroundTaskControlResult,
  InputResponseDeliveryResult,
} from "./protocol.js";

type RegistryTimer = ReturnType<typeof setTimeout>;

interface RegistryEntry {
  sessionId: string;
  client: ClaudeClient;
  attachments: number;
  lastTouchedAt: number;
  reapTimer: RegistryTimer | null;
}

export interface ClaudeSessionClientRegistryOptions {
  idleTtlMs: number;
  maxEntries: number;
  now?: () => number;
  logger?: Pick<Logger, "warn">;
}

export interface ClaudeSessionRuntimeControl {
  has(sessionId: string): boolean;
  close(sessionId: string): Promise<boolean>;
  deliverInputResponse(
    sessionId: string,
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<InputResponseDeliveryResult>;
  backgroundClaudeRuntimeTasks(
    sessionId: string,
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult>;
  stopClaudeRuntimeTask(
    sessionId: string,
    taskId: string,
  ): Promise<ClaudeBackgroundTaskControlResult>;
}

/**
 * Worker-owned session runtime boundary.
 *
 * Foreground adapters attach/release; the persistent SDK Query remains reachable
 * for background controls and AskUserQuestion responses until idle reclamation.
 */
export class ClaudeSessionClientRegistry implements ClaudeSessionRuntimeControl {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly pendingCloses = new Set<Promise<void>>();
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly logger?: Pick<Logger, "warn">;

  constructor(
    private readonly createClient: (sessionId: string) => ClaudeClient,
    options: ClaudeSessionClientRegistryOptions,
  ) {
    this.idleTtlMs = options.idleTtlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    if (this.idleTtlMs <= 0) throw new Error("Claude registry idleTtlMs must be positive");
    if (this.maxEntries <= 0) throw new Error("Claude registry maxEntries must be positive");
  }

  acquire(sessionId: string): ClaudeClient {
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.attachments += 1;
      this.touch(existing);
      return existing.client;
    }
    this.ensureCapacity();
    const entry: RegistryEntry = {
      sessionId,
      client: this.createClient(sessionId),
      attachments: 1,
      lastTouchedAt: this.now(),
      reapTimer: null,
    };
    this.entries.set(sessionId, entry);
    return entry.client;
  }

  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.attachments = Math.max(0, entry.attachments - 1);
    this.touch(entry);
    if (entry.attachments === 0) this.scheduleReap(entry);
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  async close(sessionId: string): Promise<boolean> {
    const entry = this.removeEntry(sessionId);
    if (!entry) return false;
    await this.closeClient(entry);
    return true;
  }

  async deliverInputResponse(
    sessionId: string,
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<InputResponseDeliveryResult> {
    const entry = this.entries.get(sessionId);
    if (!entry) return { status: "request_not_pending" };
    this.touch(entry);
    if (!entry.client.deliverInputResponse) return { status: "not_supported" };
    const delivered = await entry.client.deliverInputResponse(requestId, answers);
    return delivered ? { status: "delivered" } : { status: "request_not_pending" };
  }

  async backgroundClaudeRuntimeTasks(
    sessionId: string,
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult> {
    const entry = this.entries.get(sessionId);
    if (!entry) return noActiveQuery();
    this.touch(entry);
    if (!entry.client.backgroundClaudeRuntimeTasks) return notSupported();
    return await entry.client.backgroundClaudeRuntimeTasks(toolUseId);
  }

  async stopClaudeRuntimeTask(
    sessionId: string,
    taskId: string,
  ): Promise<ClaudeBackgroundTaskControlResult> {
    const entry = this.entries.get(sessionId);
    if (!entry) return noActiveQuery();
    this.touch(entry);
    if (!entry.client.stopClaudeRuntimeTask) return notSupported();
    return await entry.client.stopClaudeRuntimeTask(taskId);
  }

  async shutdown(): Promise<void> {
    const entries = [...this.entries.keys()]
      .map((sessionId) => this.removeEntry(sessionId))
      .filter((entry): entry is RegistryEntry => Boolean(entry));
    await Promise.all(entries.map(async (entry) => {
      try {
        await this.closeClient(entry);
      } catch (error) {
        this.reportCloseError(entry.sessionId, error);
      }
    }));
    await Promise.allSettled([...this.pendingCloses]);
  }

  size(): number {
    return this.entries.size;
  }

  private ensureCapacity(): void {
    if (this.entries.size < this.maxEntries) return;
    const candidate = [...this.entries.values()]
      .filter((entry) => entry.attachments === 0 && !this.mustRetain(entry))
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)[0];
    if (!candidate) {
      throw new Error(
        `Claude session registry capacity ${this.maxEntries} reached; no idle runtime is reclaimable`,
      );
    }
    this.removeEntry(candidate.sessionId);
    this.trackClose(candidate);
  }

  private scheduleReap(entry: RegistryEntry): void {
    if (entry.reapTimer) clearTimeout(entry.reapTimer);
    entry.reapTimer = setTimeout(() => {
      entry.reapTimer = null;
      if (this.entries.get(entry.sessionId) !== entry || entry.attachments > 0) return;
      if (this.mustRetain(entry)) {
        this.scheduleReap(entry);
        return;
      }
      this.removeEntry(entry.sessionId);
      this.trackClose(entry);
    }, this.idleTtlMs);
    entry.reapTimer.unref?.();
  }

  private mustRetain(entry: RegistryEntry): boolean {
    const activity = entry.client.persistentRuntimeActivity?.();
    if (!activity || activity.queryLifecycle !== "open") return false;
    return (
      activity.foregroundPhase !== "idle" ||
      activity.backgroundTaskCount > 0 ||
      activity.pendingInputRequestCount > 0
    );
  }

  private touch(entry: RegistryEntry): void {
    entry.lastTouchedAt = this.now();
    if (entry.attachments === 0 && entry.reapTimer) this.scheduleReap(entry);
  }

  private removeEntry(sessionId: string): RegistryEntry | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    this.entries.delete(sessionId);
    if (entry.reapTimer) clearTimeout(entry.reapTimer);
    entry.reapTimer = null;
    return entry;
  }

  private trackClose(entry: RegistryEntry): void {
    const pending = this.closeClient(entry).catch((error) => {
      this.reportCloseError(entry.sessionId, error);
    });
    this.pendingCloses.add(pending);
    void pending.finally(() => this.pendingCloses.delete(pending));
  }

  private async closeClient(entry: RegistryEntry): Promise<void> {
    await entry.client.close?.();
  }

  private reportCloseError(sessionId: string, error: unknown): void {
    this.logger?.warn(
      { error, sessionId },
      "Persistent Claude session runtime close failed",
    );
  }
}

function noActiveQuery(): ClaudeBackgroundTaskControlResult {
  return { status: "no_active_query", message: "No persistent Claude session runtime" };
}

function notSupported(): ClaudeBackgroundTaskControlResult {
  return {
    status: "not_supported",
    message: "Claude client does not support background task control",
  };
}
