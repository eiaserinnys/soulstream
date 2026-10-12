import type { Logger } from "pino";

import {
  isTerminalRunnerExecutionState,
  type RunnerRegistration,
} from "./runner_process_registry.js";
import type { RunnerDatabaseObservationSummary } from "./runner_phase_observation.js";

export interface RunnerRecoveryScanObservationSummary {
  nodeId: string;
  scanId: string;
  phaseDurationsMs: Record<string, number>;
  database?: RunnerDatabaseObservationSummary;
  databaseAndPhaseDurationsOverlap: true;
  nestedGcTimingOverlapsReleaseGc?: true;
}

export function closedRunnerTailRequiresDrain(registration: RunnerRegistration): boolean {
  const status = registration.closedTailState?.status;
  return status !== "fully_acknowledged" && status !== "empty_prebootstrap";
}

export function logRunnerRecoveryScan(
  logger: Pick<Logger, "info">,
  registrations: RunnerRegistration[],
  startedAt: number,
  finishedAt: number,
  observation?: RunnerRecoveryScanObservationSummary,
): void {
  const closed = registrations.filter(
    (registration) => registration.lifecycle?.execution_state === "closed",
  );
  const terminal = registrations.filter(
    (registration) => registration.lifecycle !== null
      && isTerminalRunnerExecutionState(registration.lifecycle.execution_state),
  );
  const closedTailDrains = closed.filter(closedRunnerTailRequiresDrain).length;
  logger.info({
    durationMs: Math.max(0, finishedAt - startedAt),
    registrations: registrations.length,
    terminalRegistrations: terminal.length,
    closedRegistrations: closed.length,
    closedTailDrains,
    closedTailSkips: closed.length - closedTailDrains,
    ...(observation ? {
      nodeId: observation.nodeId,
      scanId: observation.scanId,
      phaseDurationsMs: observation.phaseDurationsMs,
      ...(observation.database ? { database: observation.database } : {}),
      databaseAndPhaseDurationsOverlap: observation.databaseAndPhaseDurationsOverlap,
      ...(observation.nestedGcTimingOverlapsReleaseGc
        ? { nestedGcTimingOverlapsReleaseGc: true }
        : {}),
    } : {}),
  }, "runner recovery scan completed");
}
