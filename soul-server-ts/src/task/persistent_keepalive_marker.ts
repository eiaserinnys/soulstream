export const CACHE_KEEPALIVE_PURPOSE = "cache_keepalive";
export const CACHE_KEEPALIVE_SOURCE_TOOL = "persistent_cache_keepalive";

export function isCacheKeepaliveSchedule(
  schedule: { sourceTool?: string | null },
): boolean {
  return schedule.sourceTool === CACHE_KEEPALIVE_SOURCE_TOOL;
}

export function isCacheKeepaliveInput(
  input: { purpose?: unknown } | null | undefined,
): boolean {
  return input?.purpose === CACHE_KEEPALIVE_PURPOSE;
}
