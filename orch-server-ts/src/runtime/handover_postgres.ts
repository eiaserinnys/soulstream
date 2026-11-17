import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import type { HandoverGate } from "./handover_gate.js";

const CHANNEL = "soulstream_orch_handover";
const LOCK_CLASS = 485;
const OWNER_KEY = 1553;
const PAGE_KEY = 1554;

export class HandoverPostgres {
  private readonly id = randomUUID();
  private ownerHeld = false;
  private pageHeld = false;
  private closing = false;
  private readonly owner;
  private readonly page;
  constructor(databaseUrl: string, private readonly pageGate: HandoverGate) {
    const client = (held: () => boolean) => postgres(databaseUrl, {
      max: 1, idle_timeout: 0, max_lifetime: null,
      onclose: () => { if (!this.closing && held()) { console.error("orchestrator advisory lock connection lost"); process.exit(1); } },
    });
    this.owner = client(() => this.ownerHeld);
    this.page = client(() => this.pageHeld);
  }
  async subscribe(receive: (message: string) => void): Promise<void> {
    await this.owner.listen(CHANNEL, payload => {
      const [id, message] = payload.split(":");
      if (id !== this.id && (message === "request" || message === "ready")) receive(message);
    });
  }
  async tryOwner(): Promise<boolean> {
    const [row] = await this.owner<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_CLASS}, ${OWNER_KEY}) AS acquired`;
    return this.ownerHeld = row!.acquired;
  }
  async releaseOwner(): Promise<void> {
    await this.owner`SELECT pg_advisory_unlock(${LOCK_CLASS}, ${OWNER_KEY})`;
    this.ownerHeld = false;
  }
  async acquirePage(): Promise<void> {
    while (!this.closing) {
      const [row] = await this.page<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_CLASS}, ${PAGE_KEY}) AS acquired`;
      if (row!.acquired) { this.pageHeld = true; if (!this.closing) this.pageGate.open(); return; }
      await sleep(150);
    }
  }
  async releasePage(): Promise<void> {
    await this.pageGate.close();
    await this.page`SELECT pg_advisory_unlock(${LOCK_CLASS}, ${PAGE_KEY})`;
    this.pageHeld = false;
  }
  async notify(message: "request" | "ready"): Promise<void> { await this.owner`SELECT pg_notify(${CHANNEL}, ${`${this.id}:${message}`})`; }
  async cancel(): Promise<void> {
    this.closing = true;
    await this.pageGate.close();
  }
  async close(): Promise<void> {
    await this.cancel();
    await Promise.all([this.owner.end({ timeout: 2 }), this.page.end({ timeout: 2 })]);
  }
}
