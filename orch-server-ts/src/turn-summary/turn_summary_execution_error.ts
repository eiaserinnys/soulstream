export class TurnSummaryExecutionError extends Error {
  constructor(
    readonly attempts: number,
    readonly latencyMs: number,
    readonly spawnDurationMs: number,
    readonly peakConcurrentSpawns: number,
    cause: unknown,
    readonly previousErrors: readonly unknown[] = [],
  ) {
    super(
      previousErrors.length === 0
        ? `turn summary failed after ${attempts} attempts`
        : `turn summary failed after ${attempts} attempts; earlier stages failed: ${
          previousErrors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")
        }`,
      { cause },
    );
    this.name = "TurnSummaryExecutionError";
  }
}
