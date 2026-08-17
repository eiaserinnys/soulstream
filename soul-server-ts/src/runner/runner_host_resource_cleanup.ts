export interface RunnerHostCleanupStep {
  name: string;
  run(): void | Promise<void>;
}

/** Attempts every independent host-owned cleanup before surfacing failures. */
export async function releaseRunnerHostResources(
  steps: RunnerHostCleanupStep[],
): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(new Error(`runner host cleanup failed: ${step.name}`, {
        cause: asError(error),
      }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "runner host resource cleanup failed");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
