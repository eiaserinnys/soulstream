import type { NodeRegistryEvent } from "./registry.js";
import {
  EventIngressProtocolConflict,
  type EventIngressRepository,
} from "./event_ingress_repository.js";
import {
  EventIngressValidationError,
  parseEventAppendBatch,
  type EventCanonicalSessionProjection,
  type EventAppendAck,
  type EventAppendBatch,
  type EventSessionEffectApplication,
} from "./event_ingress_types.js";

export type NodeEventIngressCommitter = Pick<EventIngressRepository, "commitBatch">;

export type NodeEventIngressControllerOptions = {
  nodeId: string;
  connectionId: string;
  committer: NodeEventIngressCommitter;
  isCurrentConnection(): boolean;
  publish(events: NodeRegistryEvent[]): void;
  receiveCommittedEvent(message: Record<string, unknown>): NodeRegistryEvent[];
  send(frame: Record<string, unknown>): void;
  close(code: number, reason: string): void;
  logError(error: unknown, message: string): void;
  logWarn(context: Record<string, unknown>, message: string): void;
};

export class NodeEventIngressController {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  constructor(private readonly options: NodeEventIngressControllerOptions) {}

  enqueue(frame: Record<string, unknown>): void {
    if (!this.accepting) return;
    this.tail = this.tail.then(async () => await this.process(frame)).catch((error) => {
      this.accepting = false;
      this.options.logError(error, "Event ingress controller failed");
      this.options.send({
        type: "error",
        command_type: "event_append_batch",
        status: 503,
        code: "EVENT_INGRESS_TRANSIENT_FAILURE",
        retryable: true,
        message: "event ingress temporarily unavailable",
        ...ingressCoordinate(frame),
      });
      this.options.close(1011, "event_ingress:TRANSIENT_FAILURE");
    });
  }

  stop(): void {
    this.accepting = false;
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  private async process(frame: Record<string, unknown>): Promise<void> {
    if (!this.accepting || !this.options.isCurrentConnection()) return;
    let batch;
    try {
      batch = parseEventAppendBatch(frame);
    } catch (error) {
      if (error instanceof EventIngressValidationError) {
        this.accepting = false;
        this.options.send({
          type: "error",
          command_type: "event_append_batch",
          status: 400,
          code: "EVENT_INGRESS_INVALID",
          retryable: false,
          message: error.message,
          ...ingressCoordinate(frame),
        });
        this.options.close(1008, "event_ingress:INVALID_BATCH");
        return;
      }
      throw error;
    }

    try {
      const results = await this.options.committer.commitBatch(this.options.nodeId, batch);
      for (const item of results) {
        if (item.outcome === "dead_lettered") {
          this.options.logWarn({
            code: item.deadLetter.code,
            nodeId: this.options.nodeId,
            streamId: item.envelope.stream_id,
            sourceSeq: item.envelope.source_seq,
            sessionId: item.envelope.session_id,
            path: item.deadLetter.path,
          }, "Event ingress dead-lettered permanent failure");
          continue;
        }
        const payload = isRecord(item.envelope.payload)
          ? { ...item.envelope.payload, id: item.eventId, _event_id: item.eventId }
          : {
              id: item.eventId,
              type: item.envelope.event_type,
              value: item.envelope.payload,
              _event_id: item.eventId,
            };
        const registryEvents = this.options.receiveCommittedEvent({
          type: "event",
          agentSessionId: item.envelope.session_id,
          event: payload,
        });
        const sessionUpdate = item.duplicateReceipt
          && !item.sessionEffectApplication?.canonicalSession
          ? null
          : committedEffectSessionUpdate(item.envelope.session_effect, {
              sessionId: item.envelope.session_id,
              eventId: item.eventId,
            }, item.sessionEffectApplication);
        // receiveCommittedEvent updates the session cache as a side effect. Apply the
        // effect before publishing session_ended so cache-reading sinks such as
        // PushNotifier observe the committed final assistant text.
        const effectEvents = sessionUpdate
          ? this.options.receiveCommittedEvent(sessionUpdate)
          : undefined;
        try {
          this.options.publish(registryEvents);
        } catch (error) {
          this.options.logError(error, "Committed event broadcast failed");
        }
        if (effectEvents) {
          try {
            this.options.publish(effectEvents);
          } catch (error) {
            this.options.logError(error, "Committed session effect broadcast failed");
          }
        }
      }
      const ack: EventAppendAck = {
        type: "event_append_ack",
        stream_id: batch.stream_id,
        acked_through: results.at(-1)!.envelope.source_seq,
        events: results.map((item) => item.outcome === "dead_lettered"
          ? {
              source_seq: item.envelope.source_seq,
              dead_letter: {
                code: item.deadLetter.code,
                reason: item.deadLetter.reason,
                rejected_at: item.deadLetter.rejectedAt,
              },
            }
          : {
              source_seq: item.envelope.source_seq,
              event_id: item.eventId,
              ...(item.sessionEffectApplication?.canonicalSession
                ? {
                    effect_application: {
                      applied: item.sessionEffectApplication.applied,
                      canonical_session: item.sessionEffectApplication.canonicalSession,
                    },
                  }
                : {}),
            }),
      };
      this.options.send(ack);
    } catch (error) {
      if (error instanceof EventIngressProtocolConflict) {
        this.accepting = false;
        this.options.logError(error, "Event ingress receipt protocol conflict");
        this.options.send({
          type: "error",
          command_type: "event_append_batch",
          status: 409,
          code: "EVENT_INGRESS_PROTOCOL_CONFLICT",
          retryable: false,
          message: error.message,
          stream_id: batch.stream_id,
          source_seq: error.sourceSeq ?? batch.first_seq,
        });
        this.options.close(1008, "event_ingress:PROTOCOL_CONFLICT");
        return;
      }
      throw error;
    }
  }
}

function ingressCoordinate(frame: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof frame.stream_id === "string" ? { stream_id: frame.stream_id } : {}),
    ...(Number.isSafeInteger(frame.first_seq) ? { source_seq: frame.first_seq } : {}),
  };
}

function committedEffectSessionUpdate(
  effect: EventAppendBatch["events"][number]["session_effect"],
  input: { sessionId: string; eventId: number },
  application?: EventSessionEffectApplication,
): Record<string, unknown> | null {
  if (!effect) return null;
  if (application?.canonicalSession) {
    return canonicalSessionUpdate(input.sessionId, application.canonicalSession);
  }
  if (effect.kind === "last_message") {
    return {
      type: "session_updated",
      agentSessionId: input.sessionId,
      last_message: effect.last_message,
      updated_at: effect.updated_at,
      last_event_id: input.eventId,
    };
  }
  if (effect.kind === "running_transition") {
    return {
      type: "session_updated",
      agentSessionId: input.sessionId,
      status: "running",
      termination_reason: null,
      termination_detail: null,
      review_state: effect.review_state,
      updated_at: effect.updated_at,
      last_event_id: input.eventId,
    };
  }
  if (effect.kind === "terminal_transition") {
    return {
      type: "session_updated",
      agentSessionId: input.sessionId,
      status: effect.status,
      termination_reason: effect.termination_reason,
      termination_detail: effect.termination_detail,
      review_state: effect.review_state,
      last_assistant_text: effect.last_assistant_text ?? null,
      updated_at: effect.updated_at,
      last_event_id: input.eventId,
    };
  }
  return null;
}

function canonicalSessionUpdate(
  sessionId: string,
  session: EventCanonicalSessionProjection,
): Record<string, unknown> {
  return {
    type: "session_updated",
    agentSessionId: sessionId,
    status: session.status,
    termination_reason: session.termination_reason,
    termination_detail: session.termination_detail,
    review_state: session.review_state,
    last_assistant_text: session.last_assistant_text,
    termination_event_id: session.termination_event_id,
    updated_at: session.updated_at,
    last_event_id: session.last_event_id,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
