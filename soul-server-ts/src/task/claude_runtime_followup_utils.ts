export function normalizeRuntimeRevision(
  value: number | undefined,
): string | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : String(value);
}

export function normalizeRuntimeEventRevision(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function runtimeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
