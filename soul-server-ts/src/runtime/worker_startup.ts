import type { Logger } from "pino";

export interface WorkerStartupAdapter {
  run(): Promise<void>;
}

export interface WorkerStartupCoordinator {
  start(): Promise<void>;
}

export interface WorkerStartupRecovery {
  afterRunnerRecovery(): Promise<void>;
}

export interface WorkerStartupRuntime {
  createUpstreamAdapter(): WorkerStartupAdapter;
  runnerRecoveryCoordinator?: WorkerStartupCoordinator;
  claudeRuntimeStartupRecovery?: WorkerStartupRecovery;
}

export async function startWorkerRuntime<
  Runtime extends WorkerStartupRuntime,
>(options: {
  compose(): Promise<Runtime>;
  listen(runtime: Runtime): Promise<void>;
  logger: Pick<Logger, "info">;
  onUpstreamFailure(error: unknown): void;
  onRunnerRecoveryFailure(error: unknown): void;
}): Promise<{
  runtime: Runtime;
  upstreamAdapter: ReturnType<Runtime["createUpstreamAdapter"]>;
}> {
  options.logger.info("Worker runtime composition starting");
  const runtime = await options.compose();
  options.logger.info("Worker runtime composition completed");

  await options.listen(runtime);
  options.logger.info("Worker listeners ready");

  const upstreamAdapter = runtime.createUpstreamAdapter() as ReturnType<
    Runtime["createUpstreamAdapter"]
  >;
  const upstreamRun = upstreamAdapter.run();
  options.logger.info("Upstream adapter startup initiated");
  void upstreamRun.catch(options.onUpstreamFailure);

  const runnerRecovery = runtime.runnerRecoveryCoordinator;
  if (runnerRecovery) {
    options.logger.info(
      "Runner recovery initial scan starting after listeners and upstream adapter startup",
    );
  }
  const initialScan = runnerRecovery?.start() ?? Promise.resolve();
  void initialScan.then(async () => {
    if (runnerRecovery) {
      options.logger.info("Runner recovery initial scan completed");
    }
    if (runtime.claudeRuntimeStartupRecovery) {
      options.logger.info(
        "Queued delivery startup recovery starting after runner convergence",
      );
      await runtime.claudeRuntimeStartupRecovery.afterRunnerRecovery();
      options.logger.info("Queued delivery startup recovery completed");
    }
  }, options.onRunnerRecoveryFailure);

  return { runtime, upstreamAdapter };
}
