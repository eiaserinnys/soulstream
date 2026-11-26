export class TurnSummaryExecutionError extends Error {
  constructor(
    readonly attempts: number,
    readonly latencyMs: number,
    readonly spawnDurationMs: number,
    readonly peakConcurrentSpawns: number,
    cause: unknown,
    readonly fallbackError?: unknown,
  ) {
    super(
      fallbackError === undefined
        ? `turn summary failed after ${attempts} attempts`
        : `turn summary failed after ${attempts} attempts; fallback model failed: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`,
      { cause },
    );
    this.name = "TurnSummaryExecutionError";
  }
}
