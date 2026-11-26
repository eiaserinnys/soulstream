import type { Logger } from "pino";

import { isTerminalRunnerExecutionState } from "./runner_lifecycle_record.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import type { RunnerDatabaseObservationSummary } from "./runner_phase_observation.js";
import type { RunnerRegistrationCacheMissCounts } from "./runner_registration_scan_cache.js";

export interface RunnerRecoveryScanObservationSummary {
  nodeId: string;
  scanId: string;
  phaseDurationsMs: Record<string, number>;
  database?: RunnerDatabaseObservationSummary;
  registrationCacheMisses?: RunnerRegistrationCacheMissCounts;
  databaseAndPhaseDurationsOverlap: true;
  nestedGcTimingOverlapsReleaseGc?: true;
}

export function closedRunnerTailRequiresDrain(registration: RunnerRegistration): boolean {
  const status = registration.closedTailState?.status;
  return status !== "fully_acknowledged" && status !== "empty_prebootstrap";
}

export const RUNNER_RECOVERY_SCAN_SLOW_MS = 1_000;

export function logRunnerRecoveryScan(
  logger: Pick<Logger, "info" | "debug">,
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
  const durationMs = Math.max(0, finishedAt - startedAt);
  const summary = {
    durationMs,
    registrations: registrations.length,
    terminalRegistrations: terminal.length,
    closedRegistrations: closed.length,
    closedTailDrains,
    closedTailSkips: closed.length - closedTailDrains,
  };
  const handled = terminal.length > 0 || closed.length > 0;
  const noteworthy = handled || durationMs >= RUNNER_RECOVERY_SCAN_SLOW_MS;
  logger[noteworthy ? "info" : "debug"]({
    ...summary,
    ...(observation ? {
      nodeId: observation.nodeId,
      scanId: observation.scanId,
      phaseDurationsMs: observation.phaseDurationsMs,
      ...(noteworthy && observation.database ? { database: observation.database } : {}),
      ...(observation.registrationCacheMisses
        ? { registrationCacheMisses: observation.registrationCacheMisses }
        : {}),
      databaseAndPhaseDurationsOverlap: observation.databaseAndPhaseDurationsOverlap,
      ...(observation.nestedGcTimingOverlapsReleaseGc
        ? { nestedGcTimingOverlapsReleaseGc: true }
        : {}),
    } : {}),
  }, "runner recovery scan completed");
}
