import type { SSEEventPayload } from "../engine/protocol.js";
import type { ExecutionRegistration } from "../task/execution_registration.js";
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
  canonicalExecutionRegistration?: ExecutionRegistration | null;
};

/** Owns the ordered durable transition API layered over event persistence. */
export abstract class EventTransitionPublisher {
  protected abstract enqueueEvent(
    sessionId: string,
    event: SSEEventPayload,
    explicitEffect?: EventOutboxSessionEffect,
    registrationId?: string | null,
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
    return this.enqueueEvent(sessionId, event, effect, input.registrationId);
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

  async recordExecutionRegistrationAndWaitForApplication(
    sessionId: string,
    input: {
      registrationId: string;
      executionCommandId: string;
      reviewState: string;
      expectedTerminalEventId?: number | null;
      updatedAt?: Date;
    },
  ): Promise<EventSessionTransitionApplication> {
    const updatedAt = input.updatedAt ?? new Date();
    return await this.enqueueExecutionEffectAndWait(
      sessionId,
      `registration:${input.executionCommandId}`,
      {
        kind: "execution_registration",
        registration_id: input.registrationId,
        execution_command_id: input.executionCommandId,
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
    registrationId?: string,
  ): Promise<EventSessionTransitionApplication> {
    const record = await this.enqueueEvent(sessionId, event, effect, registrationId);
    return await this.waitForTransitionApplication(sessionId, record, "terminal");
  }

  private async enqueueExecutionEffectAndWait(
    sessionId: string,
    transitionId: string,
    effect: Extract<EventOutboxSessionEffect, { kind: "execution_registration" }>,
  ): Promise<EventSessionTransitionApplication> {
    const event = {
      type: "metadata",
      metadata_type: "execution_registration",
      value: { transition_id: transitionId, phase: effect.kind },
      timestamp: effect.updated_at,
      [INTERNAL_DEDUPE_KEY]: `execution_registration:${sessionId}:${transitionId}`,
    } as unknown as SSEEventPayload;
    const record = await this.enqueueEvent(sessionId, event, effect);
    return await this.waitForTransitionApplication(sessionId, record, effect.kind);
  }
}

type RunningTransitionInput = {
  reviewState: string;
  transitionId: string;
  registrationId?: string;
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
