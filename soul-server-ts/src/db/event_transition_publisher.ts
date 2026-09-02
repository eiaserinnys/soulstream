import type { SSEEventPayload } from "../engine/protocol.js";
import type {
  CanonicalExecutionOwnership,
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
    executionGeneration?: number | null,
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

  async recordExecutionGenerationAndWaitForApplication(
    sessionId: string,
    input: {
      ownerKind: ExecutionOwnerKind;
      manifestId: string;
      runtimeEnvIdentity: string;
      registrationId: string;
      pid: number;
      startIdentity: string;
      executionCommandId: string;
      reviewState: string;
      expectedTerminalEventId?: number | null;
      updatedAt?: Date;
    },
  ): Promise<EventSessionTransitionApplication> {
    const updatedAt = input.updatedAt ?? new Date();
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `generation:${input.executionCommandId}`,
      {
        kind: "execution_acquire",
        owner_kind: input.ownerKind,
        manifest_id: input.manifestId,
        runtime_env_identity: input.runtimeEnvIdentity,
        registration_id: input.registrationId,
        pid: input.pid,
        start_identity: input.startIdentity,
        execution_command_id: input.executionCommandId,
        // Legacy all-or-none session projection. This timestamp is not a lease;
        // no runtime renews it or uses it for admission after Wave 1.
        lease_expires_at: updatedAt.toISOString(),
        review_state: input.reviewState,
        ...(input.expectedTerminalEventId === undefined
          ? {}
          : { expected_terminal_event_id: input.expectedTerminalEventId }),
        updated_at: updatedAt.toISOString(),
      },
    );
  }

  async enqueueTerminalTransitionAndWaitForApplication(
    sessionId: string,
    event: SSEEventPayload,
    effect: Extract<EventOutboxSessionEffect, { kind: "terminal_transition" }>,
    executionGeneration?: number,
  ): Promise<EventSessionTransitionApplication> {
    const record = await this.enqueueEvent(sessionId, event, effect, executionGeneration);
    return await this.waitForTransitionApplication(sessionId, record, "terminal");
  }

  private async enqueueExecutionEffectAndWait(
    sessionId: string,
    transitionId: string,
    effect: Extract<EventOutboxSessionEffect, { kind: "execution_acquire" }>,
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
