import type { SSEEventPayload } from "../protocol.js";

export interface UsageLimitStopInfo {
  rateLimitType?: string;
  resetsAt?: string;
}

export function isUsageLimitTurnError(error: unknown): boolean {
  return isRecord(error) && error.codexErrorInfo === "usageLimitExceeded";
}

export function selectUsageLimitReset(
  response: unknown,
  nowEpochSec: number,
): UsageLimitStopInfo {
  if (!isRecord(response)) return {};

  const limitsById = response.rateLimitsByLimitId;
  const snapshots = isRecord(limitsById) && Object.keys(limitsById).length > 0
    ? Object.values(limitsById)
    : [response.rateLimits];
  const candidates: Array<{
    resetsAt: number;
    windowDurationMins: number | null;
  }> = [];

  for (const snapshot of snapshots) {
    if (!isRecord(snapshot)) continue;
    for (const key of ["primary", "secondary"] as const) {
      const window = snapshot[key];
      if (!isRecord(window) || typeof window.usedPercent !== "number") continue;
      if (!(window.usedPercent >= 100)) continue;
      if (
        typeof window.resetsAt !== "number" ||
        !Number.isFinite(window.resetsAt) ||
        window.resetsAt <= nowEpochSec
      ) {
        continue;
      }
      candidates.push({
        resetsAt: window.resetsAt,
        windowDurationMins: typeof window.windowDurationMins === "number"
          ? window.windowDurationMins
          : null,
      });
    }
  }

  const selected = candidates.reduce<typeof candidates[number] | undefined>(
    (latest, candidate) =>
      latest === undefined || candidate.resetsAt > latest.resetsAt
        ? candidate
        : latest,
    undefined,
  );
  if (selected === undefined) return {};

  const rateLimitType = selected.windowDurationMins === 300
    ? "five_hour"
    : selected.windowDurationMins === 10080
      ? "seven_day"
      : undefined;
  return {
    ...(rateLimitType !== undefined ? { rateLimitType } : {}),
    resetsAt: new Date(selected.resetsAt * 1000).toISOString(),
  };
}

export function buildUsageLimitStopEvents(
  errorPayload: SSEEventPayload,
  info: UsageLimitStopInfo,
): SSEEventPayload[] {
  const source = errorPayload as unknown as Record<string, unknown>;
  const rateFields = {
    ...(info.rateLimitType !== undefined
      ? { rate_limit_type: info.rateLimitType }
      : {}),
    ...(info.resetsAt !== undefined ? { resets_at: info.resetsAt } : {}),
  };

  return [
    {
      type: "credential_alert",
      status: "rejected",
      ...(typeof source.timestamp === "number" ? { timestamp: source.timestamp } : {}),
      raw_event_type: "error",
      ...(typeof source.thread_id === "string" ? { thread_id: source.thread_id } : {}),
      ...(typeof source.turn_id === "string" ? { turn_id: source.turn_id } : {}),
      ...rateFields,
    } as SSEEventPayload,
    {
      ...source,
      ...rateFields,
    } as SSEEventPayload,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
