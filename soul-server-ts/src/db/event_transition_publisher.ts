import type { SSEEventPayload } from "../engine/protocol.js";
import type {
  ExecutionIdentityProof,
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

  async reserveExecutionOwnershipAndWaitForApplication(
    sessionId: string,
    input: {
      ownershipGeneration: number;
      ownerKind: ExecutionOwnerKind;
      manifestId: string;
      updatedAt?: Date;
    },
  ): Promise<EventSessionTransitionApplication> {
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `reserve:${input.ownershipGeneration}`,
      {
        kind: "execution_reserve",
        ownership_generation: input.ownershipGeneration,
        owner_kind: input.ownerKind,
        manifest_id: input.manifestId,
        updated_at: (input.updatedAt ?? new Date()).toISOString(),
      },
    );
  }

  async proveExecutionOwnershipAndWaitForApplication(
    sessionId: string,
    ownershipGeneration: number,
    proof: ExecutionIdentityProof,
    updatedAt = new Date(),
  ): Promise<EventSessionTransitionApplication> {
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `prove:${ownershipGeneration}`,
      {
        kind: "execution_prove",
        ownership_generation: ownershipGeneration,
        registration_id: proof.registrationId,
        pid: proof.pid,
        start_identity: proof.startIdentity,
        execution_command_id: proof.executionCommandId,
        updated_at: updatedAt.toISOString(),
      },
    );
  }

  async reserveExecutionAdoptionAndWaitForApplication(
    sessionId: string,
    input: {
      ownershipGeneration: number;
      manifestId: string;
      previousRegistrationId: string;
      pid: number;
      startIdentity: string;
      updatedAt?: Date;
    },
  ): Promise<EventSessionTransitionApplication> {
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `adopt-reserve:${input.ownershipGeneration}`,
      {
        kind: "execution_adopt_reserve",
        ownership_generation: input.ownershipGeneration,
        manifest_id: input.manifestId,
        previous_registration_id: input.previousRegistrationId,
        pid: input.pid,
        start_identity: input.startIdentity,
        updated_at: (input.updatedAt ?? new Date()).toISOString(),
      },
    );
  }

  async activateExecutionOwnershipAndWaitForApplication(
    sessionId: string,
    input: {
      ownershipGeneration: number;
      reviewState: string;
      expectedTerminalEventId?: number | null;
      updatedAt?: Date;
    },
  ): Promise<EventSessionTransitionApplication> {
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `activate:${input.ownershipGeneration}`,
      {
        kind: "execution_activate",
        ownership_generation: input.ownershipGeneration,
        review_state: input.reviewState,
        ...(input.expectedTerminalEventId === undefined
          ? {}
          : { expected_terminal_event_id: input.expectedTerminalEventId }),
        updated_at: (input.updatedAt ?? new Date()).toISOString(),
      },
    );
  }

  async failExecutionOwnershipAndWaitForApplication(
    sessionId: string,
    ownershipGeneration: number,
    failureReason: string,
    updatedAt = new Date(),
  ): Promise<EventSessionTransitionApplication> {
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `fail:${ownershipGeneration}`,
      {
        kind: "execution_fail",
        ownership_generation: ownershipGeneration,
        failure_reason: failureReason,
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
      | "execution_reserve"
      | "execution_prove"
      | "execution_adopt_reserve"
      | "execution_activate"
      | "execution_fail" }>,
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
