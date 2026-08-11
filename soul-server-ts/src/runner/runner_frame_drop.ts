import type { RunnerFrame } from "./frame_protocol.js";

export interface RunnerDroppedFrame {
  channel: "event";
  kind: string;
  service?: string;
  operation?: string;
  eventType?: string;
  correlationId?: string;
  dropCount: number;
  error: Error;
}

/** Pino serializes Error correctly only under `err`; callers may supply a process-wide count. */
export function runnerDroppedFrameLogContext(
  drop: RunnerDroppedFrame,
  cumulativeDropCount: number = drop.dropCount,
): Omit<RunnerDroppedFrame, "error"> & { err: Error } {
  const { error, ...summary } = drop;
  return { ...summary, dropCount: cumulativeDropCount, err: error };
}

export function runnerDroppedFrameSummary(
  frame: RunnerFrame,
): Omit<RunnerDroppedFrame, "error" | "dropCount"> {
  if (frame.kind === "request" && frame.request.kind === "host_call") {
    const eventType = hostCallEventType(frame.request.args);
    return {
      channel: "event",
      kind: frame.kind,
      service: frame.request.service,
      operation: frame.request.operation,
      correlationId: frame.correlationId,
      ...(eventType ? { eventType } : {}),
    };
  }
  if (frame.kind === "engine_event") {
    const eventType = recordString(frame.payload, "type");
    return {
      channel: "event",
      kind: frame.kind,
      ...(eventType ? { eventType } : {}),
    };
  }
  return { channel: "event", kind: frame.kind };
}

function hostCallEventType(args: readonly unknown[]): string | undefined {
  for (const value of args) {
    const type = recordString(value, "type");
    if (type) return type;
  }
  return undefined;
}

function recordString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}
