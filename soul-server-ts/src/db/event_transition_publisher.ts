import type { SSEEventPayload } from "../engine/protocol.js";
import type {
  CanonicalExecutionOwnership,
  ExecutionOwnershipObservation,
  ExecutionOwnerKind,
} from "../task/execution_ownership.js";
import type {
  EventOutboxRecord,
  EventOutboxSessionEffect,
} from "../upstream/event_outbox.js";
import type { EventCanonicalSessionProjection } from
  "../upstream/event_outbox_pump.js";

const INTERNAL_DEDUPE_KEY = "_dedupe_key";

export type EventSessionTransitionApplication = {
  eventId: number;
  applied: boolean;
  canonicalSession: EventCanonicalSessionProjection;
  canonicalExecutionOwnership?: CanonicalExecutionOwnership | null;
};

/** Owns the ordered durable transition API layered over event persistence. */
export abstract class EventTransitionPublisher {
  protected abstract enqueueEvent(
    sessionId: string,
    event: SSEEventPayload,
    explicitEffect?: EventOutboxSessionEffect,
  ): Promise<EventOutboxRecord>;

  protected abstract waitForTransitionApplication(
    sessionId: string,
    record: EventOutboxRecord,
    transition: string,
  ): Promise<EventSessionTransitionApplication>;

  async enqueueRunningTransition(
    sessionId: string,
    input: RunningTransitionInput,
  ): Promise<EventOutboxRecord> {
    const { event, effect } = buildRunningTransitionRecord(sessionId, input);
    return this.enqueueEvent(sessionId, event, effect);
  }

  async enqueueRunningTransitionAndWaitForAck(
    sessionId: string,
    input: RunningTransitionInput,
  ): Promise<number> {
    return (await this.enqueueRunningTransitionAndWaitForApplication(
      sessionId,
      input,
    )).eventId;
  }

  async enqueueRunningTransitionAndWaitForApplication(
    sessionId: string,
    input: RunningTransitionInput,
  ): Promise<EventSessionTransitionApplication> {
    const record = await this.enqueueRunningTransition(sessionId, input);
    return await this.waitForTransitionApplication(sessionId, record, "running");
  }

  async acquireExecutionOwnershipAndWaitForApplication(
    sessionId: string,
    input: {
      ownerKind: ExecutionOwnerKind;
      manifestId: string;
      runtimeEnvIdentity: string;
      registrationId: string;
      pid: number;
      startIdentity: string;
      executionCommandId: string;
      leaseExpiresAt: Date;
      reviewState: string;
      expectedTerminalEventId?: number | null;
      updatedAt?: Date;
    },
  ): Promise<EventSessionTransitionApplication> {
    const updatedAt = input.updatedAt ?? new Date();
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `acquire:${input.executionCommandId}`,
      {
        kind: "execution_acquire",
        owner_kind: input.ownerKind,
        manifest_id: input.manifestId,
        runtime_env_identity: input.runtimeEnvIdentity,
        registration_id: input.registrationId,
        pid: input.pid,
        start_identity: input.startIdentity,
        execution_command_id: input.executionCommandId,
        lease_expires_at: input.leaseExpiresAt.toISOString(),
        review_state: input.reviewState,
        ...(input.expectedTerminalEventId === undefined
          ? {}
          : { expected_terminal_event_id: input.expectedTerminalEventId }),
        updated_at: updatedAt.toISOString(),
      },
    );
  }

  async renewExecutionOwnershipAndWaitForApplication(
    sessionId: string,
    input: {
      ownershipGeneration: number;
      ownerKind: ExecutionOwnerKind;
      manifestId: string;
      runtimeEnvIdentity: string;
      registrationId: string;
      pid: number;
      startIdentity: string;
      executionCommandId: string;
      leaseExpiresAt: Date;
      updatedAt?: Date;
    },
  ): Promise<EventSessionTransitionApplication> {
    const updatedAt = input.updatedAt ?? new Date();
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `renew:${input.ownershipGeneration}:${updatedAt.toISOString()}`,
      {
        kind: "execution_renew",
        ownership_generation: input.ownershipGeneration,
        owner_kind: input.ownerKind,
        manifest_id: input.manifestId,
        runtime_env_identity: input.runtimeEnvIdentity,
        registration_id: input.registrationId,
        pid: input.pid,
        start_identity: input.startIdentity,
        execution_command_id: input.executionCommandId,
        lease_expires_at: input.leaseExpiresAt.toISOString(),
        updated_at: updatedAt.toISOString(),
      },
    );
  }

  async backfillExecutionOwnershipAndWaitForApplication(
    sessionId: string,
    input: {
      first: ExecutionOwnershipObservation;
      second: ExecutionOwnershipObservation;
      evidenceHash: string;
      minimumLeaseIntervalMs: number;
      probeOnly: boolean;
      updatedAt?: Date;
    },
  ): Promise<EventSessionTransitionApplication> {
    const updatedAt = input.updatedAt ?? new Date();
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `backfill:${input.evidenceHash}:${input.probeOnly ? "probe" : "commit"}`,
      {
        kind: "execution_backfill",
        first_manifest_id: input.first.manifestId,
        first_runtime_env_identity: input.first.runtimeEnvIdentity,
        first_registration_id: input.first.registrationId,
        first_pid: input.first.pid,
        first_start_identity: input.first.startIdentity,
        first_execution_command_id: input.first.executionCommandId,
        first_observed_at: input.first.observedAt.toISOString(),
        second_manifest_id: input.second.manifestId,
        second_runtime_env_identity: input.second.runtimeEnvIdentity,
        second_registration_id: input.second.registrationId,
        second_pid: input.second.pid,
        second_start_identity: input.second.startIdentity,
        second_execution_command_id: input.second.executionCommandId,
        second_observed_at: input.second.observedAt.toISOString(),
        evidence_hash: input.evidenceHash,
        minimum_lease_interval_ms: input.minimumLeaseIntervalMs,
        probe_only: input.probeOnly,
        updated_at: updatedAt.toISOString(),
      },
    );
  }

  async enqueueTerminalTransitionAndWaitForApplication(
    sessionId: string,
    event: SSEEventPayload,
    effect: Extract<EventOutboxSessionEffect, { kind: "terminal_transition" }>,
  ): Promise<EventSessionTransitionApplication> {
    const record = await this.enqueueEvent(sessionId, event, effect);
    return await this.waitForTransitionApplication(sessionId, record, "terminal");
  }

  async enqueueRunnerTerminalFactAndWaitForApplication(
    sessionId: string,
    event: SSEEventPayload,
    effect: Extract<EventOutboxSessionEffect, { kind: "runner_terminal_fact" }>,
  ): Promise<EventSessionTransitionApplication> {
    const record = await this.enqueueEvent(sessionId, event, effect);
    return await this.waitForTransitionApplication(
      sessionId,
      record,
      "runner terminal fact",
    );
  }

  async enqueueRecoveredRunnerTerminalFactAndWaitForApplication(
    sessionId: string,
    event: SSEEventPayload,
    effect: Extract<EventOutboxSessionEffect, { kind: "recovered_runner_terminal_fact" }>,
  ): Promise<EventSessionTransitionApplication> {
    const record = await this.enqueueEvent(sessionId, event, effect);
    return await this.waitForTransitionApplication(
      sessionId,
      record,
      "recovered runner terminal fact",
    );
  }

  private async enqueueExecutionEffectAndWait(
    sessionId: string,
    transitionId: string,
    effect: Extract<EventOutboxSessionEffect, { kind:
      | "execution_acquire"
      | "execution_renew"
      | "execution_backfill" }>,
  ): Promise<EventSessionTransitionApplication> {
    const event = {
      type: "metadata",
      metadata_type: "execution_ownership_transition",
      value: { transition_id: transitionId, phase: effect.kind },
      timestamp: effect.updated_at,
      [INTERNAL_DEDUPE_KEY]: `execution_ownership:${sessionId}:${transitionId}`,
    } as unknown as SSEEventPayload;
    const record = await this.enqueueEvent(sessionId, event, effect);
    return await this.waitForTransitionApplication(sessionId, record, effect.kind);
  }
}

type RunningTransitionInput = {
  reviewState: string;
  transitionId: string;
  expectedTerminalEventId?: number | null;
  updatedAt?: Date;
};

function buildRunningTransitionRecord(
  sessionId: string,
  input: RunningTransitionInput,
): { event: SSEEventPayload; effect: EventOutboxSessionEffect } {
  const timestamp = (input.updatedAt ?? new Date()).toISOString();
  return {
    event: {
      type: "metadata",
      metadata_type: "session_status_transition",
      value: { status: "running", transition_id: input.transitionId },
      timestamp,
      [INTERNAL_DEDUPE_KEY]: `running_transition:${sessionId}:${input.transitionId}`,
    } as unknown as SSEEventPayload,
    effect: {
      kind: "running_transition",
      review_state: input.reviewState,
      ...(input.expectedTerminalEventId === undefined
        ? {}
        : { expected_terminal_event_id: input.expectedTerminalEventId }),
      updated_at: timestamp,
    },
  };
}
