import type {
  SessionDeliveryRow,
} from "../src/control_plane/control_plane_types.js";
import {
  ACTIVE_TURN_DELIVERY_IDS,
  RECONNECT_PENDING_DELIVERY_IDS,
  runtimeFollowupRow,
  type RuntimeFollowupFixtureRow,
} from "./runtime-followup-reconnect-wake-fixture.js";
import type { DeliveryPhaseCounts } from
  "./runtime-followup-reconnect-wake-oracle.js";

export class FakeClock {
  private value = Date.parse("2026-08-28T10:05:00.000Z");

  nowMs = (): number => this.value;

  advance(ms: number): void {
    this.value += ms;
  }
}

export class DeterministicBarrier {
  private releaseBarrier!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseBarrier = resolve;
  });

  wait(): Promise<void> {
    return this.released;
  }

  release(): void {
    this.releaseBarrier();
  }
}

export class RuntimeFollowupLedger {
  private readonly rows = new Map<string, RuntimeFollowupFixtureRow>();
  readonly counts: Record<string, DeliveryPhaseCounts> = {};

  constructor() {
    RECONNECT_PENDING_DELIVERY_IDS.forEach((deliveryId, index) => {
      this.seed(runtimeFollowupRow(deliveryId, 5170 + index));
    });
  }

  seed(row: RuntimeFollowupFixtureRow): void {
    this.rows.set(row.delivery_id, structuredClone(row));
    this.counts[row.delivery_id] = {
      claim: 0,
      dispatch: 0,
      receipt: 0,
      consume: 0,
      stale: 0,
    };
  }

  seedActiveTurn(): RuntimeFollowupFixtureRow[] {
    return ACTIVE_TURN_DELIVERY_IDS.map((deliveryId, index) => {
      const row = runtimeFollowupRow(deliveryId, 5173 + index);
      row.state = "queued";
      row.claimed_at = row.created_at;
      row.queued_at = row.created_at;
      this.seed(row);
      this.counts[deliveryId]!.claim = 1;
      this.counts[deliveryId]!.dispatch = 1;
      return structuredClone(row);
    });
  }

  pendingReconnectIds(): string[] {
    return RECONNECT_PENDING_DELIVERY_IDS.filter(
      (deliveryId) => this.rows.get(deliveryId)?.state === "pending",
    );
  }

  claimRuntimeRows(leaseOwner: string): SessionDeliveryRow[] {
    const claimed = [...this.rows.values()]
      .filter((row) => row.intent === "runtime_followup" && row.state === "pending")
      .sort((left, right) => left.enqueue_sequence - right.enqueue_sequence);
    for (const row of claimed) {
      row.state = "claimed";
      row.claimed_at = new Date("2026-08-28T10:05:01.000Z");
      row.lease_owner = leaseOwner;
      this.counts[row.delivery_id]!.claim += 1;
    }
    return claimed.map((row) => structuredClone(row) as SessionDeliveryRow);
  }

  releaseToPending(deliveryId: string): void {
    const row = this.require(deliveryId);
    row.state = "pending";
    row.claimed_at = null;
    row.lease_owner = null;
  }

  noteDispatch(deliveryId: string): void {
    const row = this.require(deliveryId);
    row.state = "queued";
    row.queued_at = new Date("2026-08-28T10:05:02.000Z");
    this.counts[deliveryId]!.dispatch += 1;
  }

  noteReceipt(deliveryId: string): void {
    this.counts[deliveryId]!.receipt += 1;
  }

  async get(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const row = this.rows.get(deliveryId);
    return row ? structuredClone(row) as SessionDeliveryRow : null;
  }

  async markConsumed(
    deliveryId: string,
    receiptId: string,
  ): Promise<SessionDeliveryRow | null> {
    const row = this.rows.get(deliveryId);
    if (!row) return null;
    row.state = "consumed";
    row.aggregate_state = "consumed";
    row.target_receipt_id = receiptId;
    row.target_receipt_at = new Date("2026-08-28T10:05:03.000Z");
    row.consumed_at = row.target_receipt_at;
    row.consumed_reason = "foreground turn result";
    this.counts[deliveryId]!.consume += 1;
    return structuredClone(row) as SessionDeliveryRow;
  }

  pendingIds(): string[] {
    return [...this.rows.values()]
      .filter((row) => row.state === "pending")
      .sort((left, right) => left.enqueue_sequence - right.enqueue_sequence)
      .map((row) => row.delivery_id);
  }

  private require(deliveryId: string): RuntimeFollowupFixtureRow {
    const row = this.rows.get(deliveryId);
    if (!row) throw new Error(`Missing runtime follow-up fixture ${deliveryId}`);
    return row;
  }
}
