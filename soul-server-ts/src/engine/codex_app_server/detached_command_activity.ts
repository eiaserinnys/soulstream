import type { CodexDetachedCommandRuntimeActivity } from "../protocol.js";
import type { AppServerNotification } from "./protocol.js";

interface ForegroundState {
  threadId: string;
  turnId: string | null;
  commandKeys: Set<string>;
}

interface RetainedTerminalResult {
  threadId: string;
  turnId: string;
  itemId: string;
  deadlineAtMs: number;
}

interface TerminalResultExpiration extends RetainedTerminalResult {
  reason: "consumption unobserved / retention expired";
}

/** Tracks only root-turn commands; child-thread work remains child-owned. */
export class CodexDetachedCommandActivityTracker {
  private readonly terminalResultRetentionMs: number;
  private readonly now: () => number;
  private foreground: ForegroundState | null = null;
  private readonly detachedCommands = new Set<string>();
  private readonly terminalResults = new Map<string, RetainedTerminalResult>();
  private readonly onTerminalResultExpired?: (event: TerminalResultExpiration) => void;

  constructor(options: {
    terminalResultRetentionMs: number;
    now?: () => number;
    onTerminalResultExpired?: (event: TerminalResultExpiration) => void;
  }) {
    this.terminalResultRetentionMs = options.terminalResultRetentionMs;
    this.now = options.now ?? Date.now;
    this.onTerminalResultExpired = options.onTerminalResultExpired;
  }

  beginForeground(threadId: string, turnId?: string): void {
    this.purgeExpiredTerminalResults();
    this.foreground = { threadId, turnId: turnId ?? null, commandKeys: new Set() };
  }

  bindForegroundTurn(threadId: string, turnId: string): void {
    const foreground = this.foreground;
    if (foreground?.threadId === threadId && foreground.turnId === null) {
      foreground.turnId = turnId;
    }
  }

  endForegroundExecution(): void {
    const foreground = this.foreground;
    if (!foreground) return;
    for (const key of foreground.commandKeys) this.detachedCommands.add(key);
    this.foreground = null;
  }

  observe(notification: AppServerNotification): void {
    const params = record(notification.params);
    const threadId = text(params, "threadId");
    const turnId = text(params, "turnId");
    switch (notification.method) {
      case "item/started": {
        const itemId = commandItemId(params?.item);
        if (threadId && turnId && itemId) this.startCommand(threadId, turnId, itemId);
        return;
      }
      case "item/completed": {
        const itemId = commandItemId(params?.item);
        if (threadId && turnId && itemId) this.completeCommand(threadId, turnId, itemId);
        return;
      }
      case "turn/started": {
        const startedTurnId = text(record(params?.turn), "id");
        if (threadId && startedTurnId) this.bindForegroundTurn(threadId, startedTurnId);
        return;
      }
      case "turn/completed": {
        const completedTurnId = text(record(params?.turn), "id");
        if (threadId && completedTurnId) this.completeForeground(threadId, completedTurnId);
        return;
      }
      case "error":
        if (params?.willRetry !== true && threadId && turnId) {
          this.completeForeground(threadId, turnId);
        }
    }
  }

  snapshot(): CodexDetachedCommandRuntimeActivity {
    this.purgeExpiredTerminalResults();
    const deadlines = [...this.terminalResults.values()].map(
      (result) => result.deadlineAtMs,
    );
    return {
      activeForegroundCount: this.foreground === null ? 0 : 1,
      detachedRunningCount: this.detachedCommands.size,
      retainedTerminalResultCount: deadlines.length,
      earliestRetainedTerminalDeadlineAtMs:
        deadlines.length === 0 ? null : Math.min(...deadlines),
    };
  }

  clear(): void {
    this.foreground = null;
    this.detachedCommands.clear();
    this.terminalResults.clear();
  }

  private startCommand(threadId: string, turnId: string, itemId: string): void {
    const foreground = this.foreground;
    if (!foreground || foreground.threadId !== threadId) return;
    if (foreground.turnId === null) foreground.turnId = turnId;
    if (foreground.turnId === turnId) {
      foreground.commandKeys.add(commandKey(threadId, turnId, itemId));
    }
  }

  private completeCommand(threadId: string, turnId: string, itemId: string): void {
    const key = commandKey(threadId, turnId, itemId);
    if (this.foreground?.commandKeys.delete(key)) return;
    if (!this.detachedCommands.delete(key)) return;
    this.terminalResults.set(key, {
      threadId,
      turnId,
      itemId,
      deadlineAtMs: this.now() + this.terminalResultRetentionMs,
    });
  }

  private completeForeground(threadId: string, turnId: string): void {
    const foreground = this.foreground;
    if (!foreground || foreground.threadId !== threadId) return;
    if (foreground.turnId !== null && foreground.turnId !== turnId) return;
    this.endForegroundExecution();
  }

  private purgeExpiredTerminalResults(): void {
    const now = this.now();
    for (const [key, result] of this.terminalResults) {
      if (result.deadlineAtMs > now) continue;
      this.terminalResults.delete(key);
      this.onTerminalResultExpired?.({
        ...result,
        reason: "consumption unobserved / retention expired",
      });
    }
  }
}

function commandKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}\u0000${turnId}\u0000${itemId}`;
}

function commandItemId(value: unknown): string | undefined {
  const item = record(value);
  return item?.type === "commandExecution" ? text(item, "id") : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof value?.[key] === "string" ? value[key] : undefined;
}
