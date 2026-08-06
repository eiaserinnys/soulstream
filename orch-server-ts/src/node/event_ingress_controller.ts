import type { NodeRegistryEvent } from "./registry.js";
import {
  EventIngressProtocolConflict,
  type EventIngressRepository,
} from "./event_ingress_repository.js";
import {
  EventIngressValidationError,
  parseEventAppendBatch,
  type EventAppendAck,
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
};

export class NodeEventIngressController {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  constructor(private readonly options: NodeEventIngressControllerOptions) {}

  enqueue(frame: Record<string, unknown>): void {
    if (!this.accepting) return;
    this.tail = this.tail.then(async () => await this.process(frame)).catch((error) => {
      this.options.logError(error, "Event ingress controller failed");
      this.options.close(1011, "event ingress failed");
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
        this.options.send({
          type: "error",
          command_type: "event_append_batch",
          status: 400,
          code: "EVENT_INGRESS_INVALID",
          message: error.message,
        });
        this.options.close(1008, "invalid event ingress batch");
        return;
      }
      throw error;
    }

    try {
      const committed = await this.options.committer.commitBatch(this.options.nodeId, batch);
      for (const item of committed) {
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
        try {
          this.options.publish(registryEvents);
        } catch (error) {
          this.options.logError(error, "Committed event broadcast failed");
        }
      }
      const ack: EventAppendAck = {
        type: "event_append_ack",
        stream_id: batch.stream_id,
        acked_through: committed.at(-1)!.envelope.source_seq,
        events: committed.map((item) => ({
          source_seq: item.envelope.source_seq,
          event_id: item.eventId,
        })),
      };
      this.options.send(ack);
    } catch (error) {
      if (error instanceof EventIngressProtocolConflict) {
        this.options.logError(error, "Event ingress receipt protocol conflict");
        this.options.send({
          type: "error",
          command_type: "event_append_batch",
          status: 409,
          code: "EVENT_INGRESS_PROTOCOL_CONFLICT",
          message: error.message,
        });
        this.options.close(1008, "event ingress protocol conflict");
        return;
      }
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
