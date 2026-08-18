import type { Logger } from "pino";

export interface WorkerStartupAdapter {
  run(): Promise<void>;
}

export interface WorkerStartupCoordinator {
  start(): Promise<void>;
}

export interface WorkerStartupRuntime {
  createUpstreamAdapter(): WorkerStartupAdapter;
  runnerRecoveryCoordinator?: WorkerStartupCoordinator;
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

  if (runtime.runnerRecoveryCoordinator) {
    options.logger.info(
      "Runner recovery initial scan starting after listeners and upstream adapter startup",
    );
    void runtime.runnerRecoveryCoordinator.start().then(
      () => options.logger.info("Runner recovery initial scan completed"),
      options.onRunnerRecoveryFailure,
    );
  }

  return { runtime, upstreamAdapter };
}
