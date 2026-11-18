import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import type { HandoverGate } from "./handover_gate.js";

const CHANNEL = "soulstream_orch_handover";
const LOCK_CLASS = 485;
const OWNER_KEY = 1553;
const PAGE_KEY = 1554;
const DEFAULT_REACQUIRE_BUDGET_MS = 60_000;
const DEFAULT_REACQUIRE_RETRY_MS = 150;
const MAX_REACQUIRE_RETRY_MS = 1_000;

type LockSql = ReturnType<typeof postgres>;

export type HandoverPostgresOptions = {
  /** Test seam: production keeps postgres.js with one connection and no idle or lifetime end. */
  readonly clientFactory?: (databaseUrl: string, onclose: () => void, onnotify?: (payload: string) => void) => LockSql;
  /** Test seam: production ends the process when the locks cannot be reacquired. */
  readonly exit?: (code: number) => void;
  /** Existing handover background controls, paused while the locks are unconfirmed. */
  readonly stopBackground?: () => Promise<void>;
  readonly resumeBackground?: () => Promise<void>;
  readonly reacquireBudgetMs?: number;
  readonly reacquireRetryMs?: number;
};

export class HandoverPostgres {
  private readonly id = randomUUID();
  private ownerHeld = false;
  private pageHeld = false;
  private ownerLost = false;
  private pageLost = false;
  private closing = false;
  private lockUnconfirmed = false;
  private recovering = false;
  private receive?: (message: string) => void;
  private readonly owner: LockSql;
  private readonly page: LockSql;
  private readonly exit: (code: number) => void;
  private readonly stopBackground?: () => Promise<void>;
  private readonly resumeBackground?: () => Promise<void>;
  private readonly reacquireBudgetMs: number;
  private readonly reacquireRetryMs: number;
  constructor(databaseUrl: string, private readonly pageGate: HandoverGate, options: HandoverPostgresOptions = {}) {
    const createClient = options.clientFactory ?? ((url: string, onclose: () => void, onnotify?: (payload: string) => void) => postgres(url, {
      max: 1, idle_timeout: 0, max_lifetime: null, onclose,
      onnotify: onnotify && ((_channel: string, payload: string) => onnotify(payload)),
    } as Parameters<typeof postgres>[1]));
    this.exit = options.exit ?? ((code: number) => process.exit(code));
    this.stopBackground = options.stopBackground;
    this.resumeBackground = options.resumeBackground;
    this.reacquireBudgetMs = options.reacquireBudgetMs ?? DEFAULT_REACQUIRE_BUDGET_MS;
    this.reacquireRetryMs = options.reacquireRetryMs ?? DEFAULT_REACQUIRE_RETRY_MS;
    // LISTEN runs on the owner lock connection itself, so the channel can never
    // outlive the lock and a reconnect re-establishes both together.
    this.owner = createClient(databaseUrl, () => this.connectionClosed("owner"), payload => this.handleNotification(payload));
    this.page = createClient(databaseUrl, () => this.connectionClosed("page"));
  }
  async subscribe(receive: (message: string) => void): Promise<void> {
    this.receive = receive;
    await this.listen();
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
      if (this.pageHeld) { this.pageGate.open(); return; }
      if (await this.tryPage()) { this.pageHeld = true; if (!this.closing) this.pageGate.open(); return; }
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

  private async tryPage(): Promise<boolean> {
    const [row] = await this.page<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_CLASS}, ${PAGE_KEY}) AS acquired`;
    return !!row!.acquired;
  }

  private async listen(): Promise<void> {
    if (!this.receive) return;
    // A raw LISTEN on the owner connection rather than postgres.js listen():
    // after a connection loss that client's automatic re-listen swallows the
    // failure and keeps a rejected channel entry that listen() can never clear.
    // Issuing LISTEN here after reacquiring the owner lock re-establishes the
    // channel on the new session, and onnotify fires exactly once per message.
    await this.owner.unsafe(`LISTEN "${CHANNEL}"`);
  }

  private handleNotification(payload: string): void {
    const [id, message] = payload.split(":");
    if (id === this.id || (message !== "request" && message !== "ready")) return;
    // While the locks are unconfirmed a request would start a handover we cannot
    // honour; the requesting instance repeats it every second.
    if (message === "request" && this.lockUnconfirmed) return;
    this.receive?.(message);
  }

  private connectionClosed(lock: "owner" | "page"): void {
    if (this.closing) return;
    if (lock === "owner") this.ownerLost = true; else this.pageLost = true;
    if (this.recovering) return;
    if (!this.ownerHeld && !this.pageHeld) {
      this.ownerLost = this.pageLost = false;
      return;
    }
    console.error("orchestrator advisory lock connection lost; reacquiring");
    this.startRecovery();
  }

  private startRecovery(): void {
    void this.recoverLocks().catch(error => {
      console.error("orchestrator advisory lock recovery failed", error);
      this.exit(1);
    });
  }

  private async recoverLocks(): Promise<void> {
    // The budget starts when the connection is lost, so a stuck page gate drain
    // or background stop cannot leave the process unconfirmed forever.
    const deadline = Date.now() + this.reacquireBudgetMs;
    this.recovering = true;
    this.lockUnconfirmed = true;
    // Only the connection that closed lost its lock. Lowering the other flag
    // would make a later acquirePage or tryOwner lock the same advisory key
    // twice on a session that still holds it, and one release would not free it.
    if (this.ownerLost) this.ownerHeld = false;
    if (this.pageLost) this.pageHeld = false;
    let backgroundPaused = false;
    let recovered = false;
    try {
      if (!await this.withinBudget(deadline, "closing the page gate", () => this.pageGate.close())) return;
      if (this.stopBackground) {
        if (!await this.withinBudget(deadline, "stopping background work", this.stopBackground)) return;
        backgroundPaused = true;
      }
      while (!this.closing && (this.ownerLost || this.pageLost)) {
        if (this.ownerLost && !await this.reacquireOwner(deadline)) return;
        if (this.closing) return;
        if (this.pageLost && !await this.reacquirePage(deadline)) return;
        if (this.closing) return;
      }
      if (this.closing) return;
      this.lockUnconfirmed = false;
      this.pageGate.open();
      if (backgroundPaused && this.resumeBackground) {
        await this.resumeBackground().catch(error => console.error("orchestrator background resume failed", error));
      }
      // The owner session died with the outage, taking its LISTEN with it;
      // restore the handover channel on the reacquired session before announcing.
      if (!await this.withinBudget(deadline, "restoring the handover listener", () => this.listen())) return;
      recovered = true;
      console.info("orchestrator advisory locks reacquired");
    } finally {
      this.recovering = false;
    }
    if (recovered && !this.closing && (this.ownerLost || this.pageLost)) {
      // A connection closed again while recovery was finishing; its close was
      // recorded but could not start a second recovery on its own.
      console.error("orchestrator advisory lock connection lost; reacquiring");
      this.startRecovery();
    }
  }

  private async withinBudget(deadline: number, step: string, work: () => Promise<void>): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { this.timedOut(step); return false; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([
        work().then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
      if (!finished) { this.timedOut(step); return false; }
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private timedOut(step: string): void {
    console.error(`orchestrator advisory lock reacquisition timed out while ${step}; exiting`);
    this.exit(1);
  }

  private async reacquireOwner(deadline: number): Promise<boolean> {
    let interval = this.reacquireRetryMs;
    for (;;) {
      if (this.closing) return false;
      try {
        if (await this.tryOwner()) { this.ownerLost = false; return true; }
        console.error("orchestrator advisory lock held by another instance; exiting");
        this.exit(1);
        return false;
      } catch (error) {
        if (Date.now() >= deadline) {
          console.error("orchestrator advisory lock reacquisition timed out; exiting", error);
          this.exit(1);
          return false;
        }
      }
      await sleep(interval);
      interval = Math.min(interval * 2, MAX_REACQUIRE_RETRY_MS);
    }
  }

  private async reacquirePage(deadline: number): Promise<boolean> {
    let interval = this.reacquireRetryMs;
    for (;;) {
      if (this.closing) return false;
      try {
        if (await this.tryPage()) { this.pageHeld = true; this.pageLost = false; return true; }
      } catch (error) {
        if (Date.now() >= deadline) {
          console.error("orchestrator advisory lock reacquisition timed out taking the page lock; exiting", error);
          this.exit(1);
          return false;
        }
        await sleep(interval);
        interval = Math.min(interval * 2, MAX_REACQUIRE_RETRY_MS);
        continue;
      }
      if (Date.now() >= deadline) {
        console.error("orchestrator advisory lock reacquisition timed out taking the page lock; exiting");
        this.exit(1);
        return false;
      }
      await sleep(this.reacquireRetryMs);
    }
  }
}
