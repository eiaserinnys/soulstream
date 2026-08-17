export function sleepWithoutHoldingProcess(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

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

export function runtimeRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function runtimeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
