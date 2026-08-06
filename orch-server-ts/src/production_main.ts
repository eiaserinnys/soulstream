import { pathToFileURL } from "node:url";

import { loadOrchServerEnvironment } from "./config.js";
import { createProductionOrchestrator } from "./production.js";

type ProcessErrorHandlerOptions = {
  readonly runtimeProcess?: Pick<NodeJS.Process, "on" | "removeListener">;
  readonly logger?: Pick<Console, "error">;
};

export function installProductionProcessErrorHandlers(
  options: ProcessErrorHandlerOptions = {},
): () => void {
  const runtimeProcess = options.runtimeProcess ?? process;
  const logger = options.logger ?? console;
  const onUnhandledRejection = (reason: unknown) => {
    logger.error("Unhandled promise rejection in orchestrator", {
      event: "orchestrator.unhandled_rejection",
      reason,
    });
  };
  const onUncaughtException = (
    error: Error,
    origin: NodeJS.UncaughtExceptionOrigin,
  ) => {
    logger.error("Uncaught exception in orchestrator", {
      event: "orchestrator.uncaught_exception",
      error,
      origin,
      fatal: true,
    });
  };
  runtimeProcess.on("unhandledRejection", onUnhandledRejection);
  runtimeProcess.on("uncaughtExceptionMonitor", onUncaughtException);
  return () => {
    runtimeProcess.removeListener("unhandledRejection", onUnhandledRejection);
    runtimeProcess.removeListener("uncaughtExceptionMonitor", onUncaughtException);
  };
}

export async function runProductionMain(): Promise<void> {
  const config = loadOrchServerEnvironment();
  const server = await createProductionOrchestrator({ config });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal}; shutting down orchestrator`);
    try {
      await server.close();
    } catch (error) {
      console.error("Orchestrator shutdown failed", error);
      process.exitCode = 1;
    }
  };
  const onSigint = () => void shutdown("SIGINT");
  const onSigterm = () => void shutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const address = await server.listen();
    console.info(`soulstream-orch-server-ts listening at ${address}`);
  } catch (error) {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    throw error;
  }
}

function isDirectEntrypoint(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isDirectEntrypoint()) {
  installProductionProcessErrorHandlers();
  runProductionMain().catch((error: unknown) => {
    console.error("Failed to start soulstream-orch-server-ts", error);
    process.exitCode = 1;
  });
}
