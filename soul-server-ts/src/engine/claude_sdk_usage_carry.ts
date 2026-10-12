import type { ClaudeClientEvent } from "./claude_client_event.js";
import { copyClaudeSdkEventMetadata } from "./claude_sdk_event_metadata.js";

type ResultEvent = Extract<ClaudeClientEvent, { type: "result" }>;
type CarriedUsage = Pick<ResultEvent, "usage" | "turnCostUsd" | "firstCall" | "model">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Numeric counters accumulate; iteration arrays and other values describe the latest Result. */
function mergeUsage(earlier: unknown, later: unknown): unknown {
  if (typeof earlier === "number" && (later === undefined || typeof later === "number")) {
    return earlier + (later ?? 0);
  }
  if (isRecord(earlier) && (later === undefined || isRecord(later))) {
    const current = later ?? {};
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(earlier), ...Object.keys(current)])) {
      const value = mergeUsage(earlier[key], current[key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  return later;
}

function sumCost(earlier: number | undefined, later: number | undefined): number | undefined {
  if (earlier === undefined) return later;
  if (later === undefined) return earlier;
  return Math.round((earlier + later) * 1_000_000) / 1_000_000;
}

/** Only Results deliberately withheld from the foreground enter this carry. */
export class ClaudeSdkUsageCarry {
  private carried: CarriedUsage | undefined;

  clear(): void {
    this.carried = undefined;
  }

  absorb(terminalEvents: ClaudeClientEvent[]): void {
    const result = terminalEvents.find((event) => event.type === "result");
    if (!result) return;
    this.carried = {
      usage: mergeUsage(this.carried?.usage, result.usage),
      turnCostUsd: sumCost(this.carried?.turnCostUsd, result.turnCostUsd),
      firstCall: this.carried?.firstCall ?? result.firstCall,
      model: result.model,
    };
  }

  applyTo(terminalEvents: ClaudeClientEvent[]): ClaudeClientEvent[] {
    const carried = this.carried;
    if (!carried) return terminalEvents;
    this.clear();
    return terminalEvents.map((event) => {
      if (event.type !== "result" && event.type !== "complete") return event;
      const usage = mergeUsage(carried.usage, event.usage);
      const turnCostUsd = sumCost(carried.turnCostUsd, event.turnCostUsd);
      const firstCall = carried.firstCall ?? event.firstCall;
      const combined: ClaudeClientEvent = {
        ...event,
        ...(usage !== undefined ? { usage } : {}),
        ...(turnCostUsd !== undefined ? { turnCostUsd } : {}),
        ...(firstCall !== undefined ? { firstCall } : {}),
      };
      // Exact-result cache entries and their private receipt stay independent of the carry.
      return copyClaudeSdkEventMetadata(event, combined, undefined);
    });
  }
}
