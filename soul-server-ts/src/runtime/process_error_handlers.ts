/**
 * A stray promise rejection anywhere in the process is fatal to Node by
 * default. In a long-lived host that owns many sessions, that means one
 * unawaited rejection in a corner takes down every session with it — the
 * failure mode that killed the orchestrator nine times before it grew the
 * same guard.
 *
 * `unhandledRejection` is logged and survived: the process keeps serving.
 * `uncaughtExceptionMonitor` only observes, so Node's own exit policy for
 * genuinely uncaught exceptions is left intact — we gain the diagnosis
 * without silently converting a crash into a zombie.
 */

export type ProcessErrorLogger = {
  error(context: Record<string, unknown>, message: string): void;
};

export type ProcessErrorHandlerOptions = {
  /** Identifies the process in logs: the host server, or a session runner child. */
  readonly component: string;
  readonly logger: ProcessErrorLogger;
  readonly runtimeProcess?: Pick<NodeJS.Process, "on" | "removeListener">;
};

export function installProcessErrorHandlers(
  options: ProcessErrorHandlerOptions,
): () => void {
  const runtimeProcess = options.runtimeProcess ?? process;
  const { component, logger } = options;

  const onUnhandledRejection = (reason: unknown) => {
    logger.error({
      event: "process.unhandled_rejection",
      component,
      err: reason,
      survived: true,
    }, "Unhandled promise rejection");
  };

  const onUncaughtException = (
    error: Error,
    origin: NodeJS.UncaughtExceptionOrigin,
  ) => {
    logger.error({
      event: "process.uncaught_exception",
      component,
      err: error,
      origin,
      fatal: true,
    }, "Uncaught exception");
  };

  runtimeProcess.on("unhandledRejection", onUnhandledRejection);
  runtimeProcess.on("uncaughtExceptionMonitor", onUncaughtException);

  return () => {
    runtimeProcess.removeListener("unhandledRejection", onUnhandledRejection);
    runtimeProcess.removeListener("uncaughtExceptionMonitor", onUncaughtException);
  };
}
