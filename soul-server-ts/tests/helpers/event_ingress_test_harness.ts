import { performance } from "node:perf_hooks";

import { NodeEventIngressController } from "../../../orch-server-ts/src/node/event_ingress_controller.js";
import {
  EventIngressRepository,
  type EventIngressQuerySql,
  type EventIngressSql,
  type EventIngressSqlProvider,
} from "../../../orch-server-ts/src/node/event_ingress_repository.js";
import type { EventAppendBatch } from "../../../orch-server-ts/src/node/event_ingress_types.js";
import type { EventOutbox, EventOutboxBatch } from "../../src/upstream/event_outbox.js";
import {
  EventOutboxPump,
  type EventAppendAck,
} from "../../src/upstream/event_outbox_pump.js";

type PersistedEvent = {
  sessionId: string;
  eventId: number;
  eventType: string;
  payload: unknown;
};

type Receipt = {
  nodeId: string;
  streamId: string;
  sourceSeq: number;
  sessionId: string;
  payloadHash: string;
  eventId: number;
};

type StoreState = {
  events: PersistedEvent[];
  receipts: Receipt[];
};

export class InMemoryEventIngressSqlProvider implements EventIngressSqlProvider {
  private state: StoreState = { events: [], receipts: [] };
  failBeforeNextCommit = false;

  get events(): readonly PersistedEvent[] {
    return this.state.events;
  }

  get receipts(): readonly Receipt[] {
    return this.state.receipts;
  }

  async resolveSql(): Promise<EventIngressSql> {
    const query = this.queryFor(this.state);
    return Object.assign(query, {
      begin: async <T>(callback: (sql: EventIngressQuerySql) => Promise<T>): Promise<T> => {
        const working = structuredClone(this.state);
        const result = await callback(this.queryFor(working));
        if (this.failBeforeNextCommit) {
          this.failBeforeNextCommit = false;
          throw new Error("fault injection: orchestrator stopped before commit");
        }
        this.state = working;
        return result;
      },
    }) as EventIngressSql;
  }

  private queryFor(state: StoreState): EventIngressQuerySql {
    return (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<readonly Record<string, unknown>[]> => {
      const statement = strings.join("?").replace(/\s+/g, " ").trim();
      if (statement.includes("FROM event_ingress_receipts")) {
        const [nodeId, streamId, sourceSeq] = values as [string, string, number];
        const receipt = state.receipts.find((item) =>
          item.nodeId === nodeId
          && item.streamId === streamId
          && item.sourceSeq === sourceSeq);
        return receipt
          ? [{
              session_id: receipt.sessionId,
              payload_hash: receipt.payloadHash,
              event_id: receipt.eventId,
            }]
          : [];
      }
      if (statement.includes("FROM sessions") && statement.includes("FOR KEY SHARE")) {
        return [{ session_id: values[0] }];
      }
      if (statement.includes("SELECT event_append(")) {
        const [sessionId, eventType, payloadJson] = values as [string, string, string];
        const eventId = state.events
          .filter((item) => item.sessionId === sessionId)
          .reduce((maximum, item) => Math.max(maximum, item.eventId), 0) + 1;
        state.events.push({
          sessionId,
          eventId,
          eventType,
          payload: JSON.parse(payloadJson) as unknown,
        });
        return [{ event_id: eventId }];
      }
      if (statement.includes("INSERT INTO event_ingress_receipts")) {
        const [nodeId, streamId, sourceSeq, sessionId, payloadHash, eventId] = values as [
          string, string, number, string, string, number,
        ];
        state.receipts.push({ nodeId, streamId, sourceSeq, sessionId, payloadHash, eventId });
        return [];
      }
      throw new Error(`unexpected event ingress SQL: ${statement}`);
    }) as EventIngressQuerySql;
  }
}

export class EventIngressTestHarness {
  readonly provider = new InMemoryEventIngressSqlProvider();
  readonly repository = new EventIngressRepository(this.provider);
  readonly rawBroadcastEventIds: number[] = [];
  readonly displayedEventIds = new Set<number>();
  readonly closeReasons: string[] = [];
  readonly ackLatenciesMs: number[] = [];
  duplicateReceiptCount = 0;
  ackFramesSent = 0;

  async processBatch(
    pump: EventOutboxPump,
    batch: EventOutboxBatch,
    options: { crashBeforeAck?: boolean; persistAck?: boolean } = {},
  ): Promise<void> {
    const pendingAcks: Promise<void>[] = [];
    let crashBeforeAck = options.crashBeforeAck ?? false;
    const startedAt = performance.now();
    const controller = new NodeEventIngressController({
      nodeId: "node-a",
      connectionId: "connection-a",
      isCurrentConnection: () => true,
      committer: {
        commitBatch: async (nodeId: string, value: EventAppendBatch) => {
          const committed = await this.repository.commitBatch(nodeId, value);
          this.duplicateReceiptCount += committed.filter(
            (item) => item.outcome !== "dead_lettered" && item.duplicateReceipt,
          ).length;
          return committed;
        },
      },
      receiveCommittedEvent: (message) => {
        if (crashBeforeAck) {
          crashBeforeAck = false;
          throw new Error("fault injection: orchestrator stopped after commit before ACK");
        }
        if (message.type === "event") {
          const event = message.event as Record<string, unknown>;
          const eventId = Number(event._event_id);
          this.rawBroadcastEventIds.push(eventId);
          this.displayedEventIds.add(eventId);
        }
        return [];
      },
      publish: () => undefined,
      send: (frame) => {
        if (frame.type !== "event_append_ack") return;
        this.ackFramesSent += 1;
        if (options.persistAck === false) return;
        pendingAcks.push(pump.handleAck(frame as EventAppendAck));
      },
      close: (_code, reason) => this.closeReasons.push(reason),
      logError: () => undefined,
      logWarn: () => undefined,
    });

    controller.enqueue(batch as unknown as Record<string, unknown>);
    await controller.drain();
    await Promise.all(pendingAcks);
    if (pendingAcks.length > 0) {
      this.ackLatenciesMs.push(performance.now() - startedAt);
    }
  }
}

export async function transmitOneBatch(
  pump: EventOutboxPump,
  harness: EventIngressTestHarness,
  options: { crashBeforeAck?: boolean; persistAck?: boolean } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pump.connect(async (batch) => {
      try {
        await harness.processBatch(pump, batch, options);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function drainOutbox(
  outbox: EventOutbox,
  pump: EventOutboxPump,
  harness: EventIngressTestHarness,
  expectedAckedSeq: number,
): Promise<void> {
  pump.connect(async (batch) => await harness.processBatch(pump, batch));
  await waitFor(() => outbox.ackedSeq === expectedAckedSeq, 30_000);
}

export function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("p95 requires at least one value");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("event ingress harness timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
