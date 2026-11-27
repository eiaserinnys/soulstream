const MAX_CAUSE_DEPTH = 5;

/** Errors that mean a model stage is out of quota or unusable, so the next stage should run. */
export const STAGE_HANDOFF_ERROR_CODES: ReadonlySet<string> = new Set([
  "CLAUDE_USAGE_LIMIT",
  "CLAUDE_UNAVAILABLE",
  "ANTIGRAVITY_RATE_LIMITED",
  "CODEX_USAGE_LIMIT",
]);

export function findUsageLimitError(error: unknown): Record<string, unknown> | undefined {
  return findHandoffError(error, 0);
}

export function isTurnSummaryUsageLimitError(error: unknown): boolean {
  return findUsageLimitError(error) !== undefined;
}

function findHandoffError(error: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth >= MAX_CAUSE_DEPTH || error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string" && STAGE_HANDOFF_ERROR_CODES.has(record.code)) return record;
  if (Array.isArray(record.previousErrors)) {
    for (const previous of record.previousErrors) {
      const found = findHandoffError(previous, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return findHandoffError(record.cause, depth + 1);
}

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
