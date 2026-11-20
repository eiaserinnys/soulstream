const MAX_CAUSE_DEPTH = 5;

export function findErrorInChain(
  error: unknown,
  code: string,
): Record<string, unknown> | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    if (record.code === code) return record;
    current = record.cause;
  }
  return undefined;
}

export function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
