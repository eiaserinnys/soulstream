import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { expect, it, vi } from "vitest";
import { HandoverGate } from "../src/runtime/handover_gate.js";
import { HandoverPostgres } from "../src/runtime/handover_postgres.js";

type LockSql = ReturnType<typeof postgres>;
type TryOutcome = "acquired" | "held" | "error";

class FakeLockClient {
  readonly calls: string[] = [];
  outcome: TryOutcome = "acquired";
  private onclose?: () => void;
  private notify?: (payload: string) => void;
  readonly sql: LockSql;

  constructor() {
    const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.map((part, index) => `${part}${index < values.length ? "?" : ""}`).join("").trim();
      this.calls.push(text);
      if (text.includes("pg_try_advisory_lock")) {
        if (this.outcome === "error") throw new Error("connection refused");
        return [{ acquired: this.outcome === "acquired" }];
      }
      if (text.includes("pg_advisory_unlock")) return [{ unlocked: true }];
      return [];
    }) as unknown as LockSql;
    const client = query as unknown as {
      listen: (channel: string, onnotify: (value: string) => void) => Promise<unknown>;
      end: () => Promise<void>;
    };
    client.listen = async (_channel, onnotify) => { this.notify = onnotify; return {}; };
    client.end = async () => {};
    this.sql = query;
  }

  attach(onclose: () => void): void { this.onclose = onclose; }
  closeConnection(): void { this.onclose?.(); }
  deliver(payload: string): void { this.notify?.(payload); }
  get tryCount(): number { return this.calls.filter(call => call.includes("pg_try_advisory_lock")).length; }
}

function createLocks(
  owner: FakeLockClient,
  page: FakeLockClient,
  overrides: {
    reacquireBudgetMs?: number;
    reacquireRetryMs?: number;
    stopBackground?: () => Promise<void>;
    resumeBackground?: () => Promise<void>;
  } = {},
) {
  const gate = new HandoverGate();
  const exits: number[] = [];
  const clients = [owner, page];
  let created = 0;
  const locks = new HandoverPostgres("postgres://fake", gate, {
    clientFactory: (_url, onclose) => {
      const client = clients[created++]!;
      client.attach(onclose);
      return client.sql;
    },
    exit: code => exits.push(code),
    stopBackground: overrides.stopBackground,
    resumeBackground: overrides.resumeBackground,
    reacquireRetryMs: overrides.reacquireRetryMs ?? 5,
    reacquireBudgetMs: overrides.reacquireBudgetMs ?? 500,
  });
  return { locks, gate, exits };
}

it("reacquires both locks and reopens the page gate after the lock connections close", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const events: string[] = [];
  const { locks, gate, exits } = createLocks(owner, page, {
    stopBackground: async () => { events.push("stop"); },
    resumeBackground: async () => { events.push("resume"); },
  });
  try {
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();
    await expect(gate.run(async () => "open")).resolves.toBe("open");

    owner.closeConnection();
    page.closeConnection();
    await vi.waitFor(() => expect(owner.tryCount).toBe(2));
    await vi.waitFor(() => expect(page.tryCount).toBe(2));
    await vi.waitFor(async () => { await expect(gate.run(async () => "open")).resolves.toBe("open"); });
    expect(events).toEqual(["stop", "resume"]);
    expect(exits).toEqual([]);

    // A later close starts recovery again, so both held flags came back.
    owner.closeConnection();
    await vi.waitFor(() => expect(owner.tryCount).toBe(3));
    await vi.waitFor(async () => { await expect(gate.run(async () => "open")).resolves.toBe("open"); });
    page.closeConnection();
    await vi.waitFor(() => expect(page.tryCount).toBe(3));
    await vi.waitFor(async () => { await expect(gate.run(async () => "open")).resolves.toBe("open"); });
    expect(exits).toEqual([]);
  } finally { await locks.close(); }
});

it("ends the process when another instance holds the owner lock", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const { locks, gate, exits } = createLocks(owner, page);
  try {
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();
    owner.outcome = "held";
    owner.closeConnection();
    await vi.waitFor(() => expect(exits).toEqual([1]));
    await expect(gate.run(async () => "open")).rejects.toMatchObject({ statusCode: 503 });
  } finally { await locks.close(); }
});

it("ends the process when the reacquisition budget runs out", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const { locks, exits } = createLocks(owner, page, { reacquireBudgetMs: 50, reacquireRetryMs: 5 });
  try {
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();
    owner.outcome = "error";
    owner.closeConnection();
    await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 2_000 });
    expect(owner.tryCount).toBeGreaterThan(1);
  } finally { await locks.close(); }
});

it("ignores lock connection closes during shutdown", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const { locks, exits } = createLocks(owner, page);
  try {
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();
    await locks.cancel();
    owner.closeConnection();
    page.closeConnection();
    await sleep(30);
    expect(owner.tryCount).toBe(1);
    expect(page.tryCount).toBe(1);
    expect(exits).toEqual([]);
  } finally { await locks.close(); }
});

it("ignores handover requests while the locks are unconfirmed", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const { locks, gate, exits } = createLocks(owner, page, { reacquireBudgetMs: 2_000, reacquireRetryMs: 5 });
  const received: string[] = [];
  try {
    await locks.subscribe(message => received.push(message));
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();

    owner.deliver("peer:request");
    owner.deliver("peer:ready");
    expect(received).toEqual(["request", "ready"]);

    owner.outcome = "error";
    owner.closeConnection();
    page.closeConnection();
    owner.deliver("peer:request");
    expect(received).toEqual(["request", "ready"]);

    owner.outcome = "acquired";
    await vi.waitFor(async () => { await expect(gate.run(async () => "open")).resolves.toBe("open"); }, { timeout: 3_000 });
    owner.deliver("peer:request");
    expect(received).toEqual(["request", "ready", "request"]);
    expect(exits).toEqual([]);
  } finally { await locks.close(); }
});
