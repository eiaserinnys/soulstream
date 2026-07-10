import { pathToFileURL } from "node:url";

import { loadOrchServerEnvironment } from "./config.js";
import { createProductionOrchestrator } from "./production.js";

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
  runProductionMain().catch((error: unknown) => {
    console.error("Failed to start soulstream-orch-server-ts", error);
    process.exitCode = 1;
  });
}
