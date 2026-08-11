export interface RunnerNodeRuntimePreflightOptions {
  runnerProcessEnabled: boolean;
  nodeVersion: string;
  execArgv?: readonly string[];
  probeNodeSqlite?: () => Promise<unknown>;
}

export async function assertRunnerNodeRuntime(
  options: RunnerNodeRuntimePreflightOptions,
): Promise<void> {
  if (!options.runnerProcessEnabled) return;
  try {
    await (options.probeNodeSqlite ?? probeNodeSqlite)();
  } catch (cause) {
    throw nodeSqliteCapabilityError({
      nodeVersion: options.nodeVersion,
      execArgv: options.execArgv ?? process.execArgv,
      cause,
    });
  }
}

export function nodeSqliteCapabilityError(options: {
  nodeVersion: string;
  execArgv: readonly string[];
  cause: unknown;
}): Error {
  const execArgv = options.execArgv.length > 0
    ? options.execArgv.join(" ")
    : "(none)";
  return new Error(
    "SOUL_RUNNER_PROCESS_ENABLED=true requires node:sqlite, but the capability probe failed "
      + `on Node.js ${options.nodeVersion} (execArgv: ${execArgv}). `
      + "Node.js 22.5.0-22.12.x and 23.0.0-23.3.x require --experimental-sqlite; "
      + "use that flag or Node.js >=22.13.0 or >=23.4.0.",
    { cause: options.cause },
  );
}

async function probeNodeSqlite(): Promise<unknown> {
  return await import("node:sqlite");
}
