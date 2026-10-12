import type {
  RunnerDurableRetentionProbe,
  RunnerRegistration,
} from "./runner_process_registry.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import {
  readRunnerHostAcknowledgedThrough,
  runnerHostStatePath,
} from "./runner_host_state_store.js";
import type { RunnerPhaseObservation } from "./runner_phase_observation.js";

/** Reads only durable retention metadata; null requires the existing full inspector. */
export async function probeRunnerDurableRetention(
  registration: RunnerRegistration,
  phaseObservation?: RunnerPhaseObservation,
): Promise<RunnerDurableRetentionProbe> {
  const fallback = (): RunnerDurableRetentionProbe => ({
    registration,
    localRetentionReason: null,
  });
  const closedTail = registration.closedTailState;
  if (closedTail?.status === "unknown") return fallback();
  if (
    closedTail !== undefined
    && closedTail.sessionId !== registration.config.sessionId
  ) return fallback();
  if (closedTail?.status === "requires_drain") {
    return { registration, localRetentionReason: "final_ack_pending" };
  }

  let outbox: RunnerSqliteEventOutbox | undefined;
  try {
    const retention = await RunnerSqliteEventOutbox.openReadOnlyRetentionProbe(
      registration.config.paths.databasePath,
      {
        sessionId: registration.config.sessionId,
        ...(phaseObservation ? { phaseObservation } : {}),
      },
    );
    outbox = retention.outbox;
    const bootstrap = retention.bootstrap;
    if (bootstrap && bootstrap.session_id !== registration.config.sessionId) return fallback();
    if (closedTail?.status === "empty_prebootstrap" && bootstrap !== null) return fallback();
    if (
      closedTail?.status === "fully_acknowledged"
      && (
        !bootstrap
        || bootstrap.stream_id !== closedTail.streamId
        || retention.latestDurableSourceSeq !== closedTail.latestDurableSourceSeq
      )
    ) return fallback();

    const lifecycle = registration.lifecycle;
    const hydrated = { ...registration, bootstrap, lifecycle };
    if (!lifecycle) {
      return { registration: hydrated, localRetentionReason: "incomplete_bootstrap" };
    }
    if (!bootstrap) {
      const readEvidence = () => outbox!.inspectPendingDurableEvidence();
      const evidence = phaseObservation
        ? phaseObservation.runSync("dbRead", {
          sessionId: registration.config.sessionId,
          databasePath: registration.config.paths.databasePath,
          label: "runner prebootstrap retention evidence",
        }, readEvidence)
        : readEvidence();
      if (evidence.durableRecordCount > 0) return fallback();
      const hasBlocker = evidence.unacknowledgedIpcFrameCount > 0
        || evidence.pendingInterventionCount > 0;
      return {
        registration: hydrated,
        localRetentionReason: hasBlocker ? "incomplete_bootstrap" : null,
      };
    }

    const latestDurableSourceSeq = retention.latestDurableSourceSeq;
    const acknowledgedThrough = closedTail?.status === "fully_acknowledged"
      ? closedTail.acknowledgedThrough
      : readRunnerHostAcknowledgedThrough(
        runnerHostStatePath(registration.config.paths.databasePath),
        bootstrap.stream_id,
        bootstrap.session_id,
        phaseObservation
          ? {
            phaseObservation,
            sessionId: registration.config.sessionId,
            label: "runner retention host ACK",
          }
          : undefined,
      );
    if (
      acknowledgedThrough === null
      || acknowledgedThrough !== latestDurableSourceSeq
    ) {
      return { registration: hydrated, localRetentionReason: "final_ack_pending" };
    }
    const hasPendingWork = phaseObservation
      ? await phaseObservation.runAsync("dbRead", {
        sessionId: registration.config.sessionId,
        databasePath: registration.config.paths.databasePath,
        label: "runner retention pending durable work",
      }, () => outbox!.hasPendingDurableWork(acknowledgedThrough))
      : await outbox.hasPendingDurableWork(acknowledgedThrough);
    return {
      registration: hydrated,
      localRetentionReason: hasPendingWork ? "durable_replay_pending" : null,
    };
  } catch {
    return fallback();
  } finally {
    outbox?.close();
  }
}
