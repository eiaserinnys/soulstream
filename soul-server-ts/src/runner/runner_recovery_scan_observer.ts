import type { Logger } from "pino";

import type { RunnerRegistration } from "./runner_process_registry.js";

export function closedRunnerTailRequiresDrain(registration: RunnerRegistration): boolean {
  const status = registration.closedTailState?.status;
  return status !== "fully_acknowledged" && status !== "empty_prebootstrap";
}

export function logRunnerRecoveryScan(
  logger: Pick<Logger, "info">,
  registrations: RunnerRegistration[],
  startedAt: number,
  finishedAt: number,
): void {
  const closed = registrations.filter(
    (registration) => registration.lifecycle?.execution_state === "closed",
  );
  const closedTailDrains = closed.filter(closedRunnerTailRequiresDrain).length;
  logger.info({
    durationMs: Math.max(0, finishedAt - startedAt),
    registrations: registrations.length,
    closedRegistrations: closed.length,
    closedTailDrains,
    closedTailSkips: closed.length - closedTailDrains,
  }, "runner recovery scan completed");
}
