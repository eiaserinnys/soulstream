import type { EventOutboxBatch } from "./event_outbox.js";
import {
  type EventAppendAck,
  type EventIngressRejection,
  type EventOutboxPumpTransport,
  EventOutboxPump,
} from "./event_outbox_pump.js";

/**
 * Routes multiple durable stream pumps over the worker's one upstream socket.
 * The node-global JSONL stream remains registered for the lifetime of the
 * process; per-session runner streams register and unregister independently.
 */
export class EventOutboxPumpMux implements EventOutboxPumpTransport {
  private readonly pumps = new Map<string, EventOutboxPump>();
  private sender?: (batch: EventOutboxBatch) => Promise<void>;

  constructor(primary: EventOutboxPump) {
    this.pumps.set(primary.streamId, primary);
  }

  register(pump: EventOutboxPump): () => void {
    if (this.pumps.has(pump.streamId)) {
      throw new Error(`Durable event stream already registered: ${pump.streamId}`);
    }
    this.pumps.set(pump.streamId, pump);
    if (this.sender) pump.connect(this.sender);
    return () => {
      if (this.pumps.get(pump.streamId) !== pump) return;
      pump.disconnect();
      this.pumps.delete(pump.streamId);
    };
  }

  async connect(sender: (batch: EventOutboxBatch) => Promise<void>): Promise<boolean> {
    this.sender = sender;
    const readiness = [...this.pumps.values()].map(async (pump) =>
      (await pump.connect(sender)) !== false);
    return (await Promise.all(readiness)).every(Boolean);
  }

  disconnect(): void {
    this.sender = undefined;
    for (const pump of this.pumps.values()) pump.disconnect();
  }

  isAck(value: unknown): value is EventAppendAck {
    return Boolean(value && typeof value === "object"
      && (value as Record<string, unknown>).type === "event_append_ack");
  }

  async handleAck(ack: EventAppendAck): Promise<void> {
    const pump = this.pumps.get(ack.stream_id);
    // A runner may unregister after send but before its ACK returns. The
    // durable cursor remains in SQLite and advances after the next registered
    // pump retransmits, so a late ACK must not poison the shared ACK mux.
    if (!pump) return;
    await pump.handleAck(ack);
  }

  isRejection(value: unknown): value is EventIngressRejection {
    return [...this.pumps.values()].some((pump) => pump.isRejection(value));
  }

  async handleRejection(rejection: EventIngressRejection) {
    const pump = this.pumps.get(rejection.stream_id);
    if (!pump) return null;
    return await pump.handleRejection(rejection);
  }
}
