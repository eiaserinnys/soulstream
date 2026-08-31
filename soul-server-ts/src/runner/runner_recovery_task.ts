import type { Logger } from "pino";

import type { Task } from "../task/task_models.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import { RunnerSqliteLifecycle } from "./sqlite_runner_lifecycle.js";
import { RunnerWriterLock } from "./runner_writer_lock.js";

export async function markRegistrationReaped(
  registration: RunnerRegistration,
  progressedAt: string,
  error: { code: string; message: string },
  logger: Pick<Logger, "error" | "info" | "warn">,
): Promise<void> {
  const writerLock = await RunnerWriterLock.acquire(registration.config.paths.lockPath);
  try {
    const lifecycle = RunnerSqliteLifecycle.open(
      registration.config.paths.databasePath,
      undefined,
      {
        onSummaryRenameFailure: (renameError, path, details) => {
          const context = {
            err: renameError,
            path,
            consecutiveFailures: details.consecutiveFailures,
          };
          if (details.severity === "error") {
            logger.error(
              context,
              "Runner lifecycle summary rename failure persisted; durable SQLite state retained",
            );
          } else {
            logger.warn(
              context,
              "Runner lifecycle summary rename retries exhausted; durable SQLite state retained",
            );
          }
        },
        onSummaryRenameRecovery: (path, recoveredAfterFailures) => logger.info(
          { path, recoveredAfterFailures },
          "Runner lifecycle summary rename recovered",
        ),
      },
    );
    try {
      lifecycle.reap(
        registration.lifecycle!.execution_command_id,
        progressedAt,
        error,
      );
    } finally {
      lifecycle.close();
    }
  } finally {
    await writerLock.release();
  }
}

export function prepareRecoveredTask(
  task: Task,
  registration: RunnerRegistration,
): void {
  task.agentProfileSnapshot = registration.config.agent;
  const backendSessionId = registration.bootstrap?.payload.backend_session_id;
  if (backendSessionId) task.codexThreadId = backendSessionId;
  if (
    registration.registrationId
    && registration.pid
    && registration.pidStartIdentity
    && registration.lifecycle?.execution_command_id
  ) {
    task.recoveredExecutionOwnership = {
      manifestId: registration.config.releaseManifestId ?? registration.config.codeSha,
      runtimeEnvIdentity:
        registration.config.runtimeEnvIdentity ?? `legacy:${registration.config.codeSha}`,
      registrationId: registration.registrationId,
      pid: registration.pid,
      startIdentity: registration.pidStartIdentity,
      executionCommandId: registration.lifecycle.execution_command_id,
    };
  }
}

export function requireRecoveryTask(
  task: Task | undefined,
  registration: RunnerRegistration,
): Task {
  if (task) return task;
  throw new Error(
    `runner recovery task missing after hydration: ${registration.config.sessionId}`,
  );
}
