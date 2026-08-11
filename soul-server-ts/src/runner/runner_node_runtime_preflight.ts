const MINIMUM_NODE_SQLITE_VERSION = [22, 5, 0] as const;

export interface RunnerNodeRuntimePreflightOptions {
  runnerProcessEnabled: boolean;
  nodeVersion: string;
}

export function assertRunnerNodeRuntime(
  options: RunnerNodeRuntimePreflightOptions,
): void {
  if (!options.runnerProcessEnabled) return;
  const current = parseNodeVersion(options.nodeVersion);
  if (!current) {
    throw new Error(
      `SOUL_RUNNER_PROCESS_ENABLED=true could not parse current Node.js version: ${options.nodeVersion}`,
    );
  }
  if (compareVersions(current, MINIMUM_NODE_SQLITE_VERSION) < 0) {
    throw new Error(
      "SOUL_RUNNER_PROCESS_ENABLED=true requires Node.js >=22.5.0 "
      + `for node:sqlite; current ${options.nodeVersion}`,
    );
  }
}

function parseNodeVersion(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
