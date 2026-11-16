import { pathToFileURL } from "node:url";

import {
  modelCatalogPathForRepository,
  openModelCatalogFile,
  repositoryRootFromEntryUrl,
} from "@soulstream/model-catalog/file-loader";

import { loadOrchServerEnvironment } from "./config.js";
import { createProductionOrchestrator } from "./production.js";

type ProcessErrorHandlerOptions = {
  readonly runtimeProcess?: Pick<NodeJS.Process, "on" | "removeListener">;
  readonly logger?: Pick<Console, "error">;
};

/**
 * Haniel stops a service with SIGTERM and force-kills it after its own timeout
 * (30s on the server). The orchestrator must finish (or at least say where it
 * got stuck) well before that, so operators can see the cause in the service
 * log instead of guessing from a SIGKILL.
 */
export const SHUTDOWN_DEADLINE_MS = 10_000;

type ShutdownDeadlineOptions = {
  readonly currentStage: () => string;
  readonly deadlineMs?: number;
  readonly logger?: {
    error(message: string, bindings: Record<string, unknown>): void;
  };
  readonly exit?: (code: number) => void;
};

/** Arms the unref'd safety net; the returned function clears it. */
export function armShutdownDeadline(
  options: ShutdownDeadlineOptions,
): () => void {
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const logger = options.logger ?? console;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timer = setTimeout(() => {
    logger.error("orchestrator shutdown deadline exceeded; exiting", {
      event: "orchestrator.shutdown_deadline",
      stage: options.currentStage(),
      deadline_ms: deadlineMs,
    });
    exit(1);
  }, deadlineMs);
  timer.unref();
  return () => clearTimeout(timer);
}

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
  // The repository's canonical catalogue file is the only source of presets,
  // rates and display names. A failed first load stops startup instead of
  // serving stale built-in data.
  const modelCatalog = openModelCatalogFile({
    path: modelCatalogPathForRepository(repositoryRootFromEntryUrl(import.meta.url)),
    // A bad runtime edit keeps the last good catalogue; the log is how an operator learns of it.
    logger: { error: (bindings, message) => console.error(message, bindings) },
  });
  modelCatalog.start();
  let shutdownStage = "shutdown_notice";
  let server: Awaited<ReturnType<typeof createProductionOrchestrator>>;
  try {
    server = await createProductionOrchestrator({
      config,
      modelCatalog,
      onShutdownStage: (step) => {
        shutdownStage = step;
      },
    });
  } catch (error) {
    modelCatalog.close();
    throw error;
  }
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal}; shutting down orchestrator`);
    const clearShutdownDeadline = armShutdownDeadline({
      currentStage: () => shutdownStage,
    });
    try {
      await server.close();
    } catch (error) {
      console.error("Orchestrator shutdown failed", error);
      process.exitCode = 1;
    } finally {
      clearShutdownDeadline();
      modelCatalog.close();
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
    modelCatalog.close();
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
