import type { AppServerTurnError } from "./protocol.js";

export function nowEpochSec(): number {
  return Date.now() / 1000;
}

export function timestampFromMs(ms: number | undefined): number {
  return typeof ms === "number" ? ms / 1000 : nowEpochSec();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fieldString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

export function jsonStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

export function errorMessage(error: AppServerTurnError | null | undefined): string {
  return error?.message ?? "Codex app-server turn failed";
}

export function isTurnError(value: unknown): value is AppServerTurnError {
  return isRecord(value) && typeof value.message === "string";
}

export function rawContext(
  method: string,
  params: { threadId?: string; turnId?: string; itemId?: string },
): Record<string, unknown> {
  return {
    raw_event_type: method,
    ...(params.threadId ? { thread_id: params.threadId } : {}),
    ...(params.turnId ? { turn_id: params.turnId } : {}),
    ...(params.itemId ? { tool_use_id: params.itemId } : {}),
  };
}
