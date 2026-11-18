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
      unsafe: (text: string) => Promise<unknown>;
      end: () => Promise<void>;
    };
    client.unsafe = async text => { this.calls.push(text); return []; };
    client.end = async () => {};
    this.sql = query;
  }

  attach(onclose: () => void, notify?: (payload: string) => void): void {
    this.onclose = onclose;
    this.notify = notify;
  }
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
    clientFactory: (_url, onclose, onnotify) => {
      const client = clients[created++]!;
      client.attach(onclose, onnotify);
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

it("reacquires only the owner lock when the owner connection closes", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const { locks, gate, exits } = createLocks(owner, page);
  try {
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();

    owner.closeConnection();
    await vi.waitFor(() => expect(owner.tryCount).toBe(2));
    await vi.waitFor(async () => { await expect(gate.run(async () => "open")).resolves.toBe("open"); });
    // The page session still holds its advisory lock. Locking again on that
    // session would take it twice and one release would leave it held.
    expect(page.tryCount).toBe(1);
    expect(exits).toEqual([]);
  } finally { await locks.close(); }
});

it("reacquires only the page lock when the page connection closes", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const { locks, gate, exits } = createLocks(owner, page);
  try {
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();

    page.closeConnection();
    await vi.waitFor(() => expect(page.tryCount).toBe(2));
    await vi.waitFor(async () => { await expect(gate.run(async () => "open")).resolves.toBe("open"); });
    expect(owner.tryCount).toBe(1);
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

it("counts a stuck background stop against the reacquisition budget", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const { locks, exits } = createLocks(owner, page, {
    reacquireBudgetMs: 50,
    reacquireRetryMs: 5,
    stopBackground: () => new Promise<void>(() => {}),
  });
  try {
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();
    owner.closeConnection();
    await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 2_000 });
    // No reacquisition was attempted: the budget ran out while waiting.
    expect(owner.tryCount).toBe(1);
  } finally { await locks.close(); }
});

it("counts a stuck page gate drain against the reacquisition budget", async () => {
  const owner = new FakeLockClient(), page = new FakeLockClient();
  const { locks, gate, exits } = createLocks(owner, page, { reacquireBudgetMs: 50, reacquireRetryMs: 5 });
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const inFlight = gate.run(async () => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
    return "done";
  });
  try {
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();
    await running;
    owner.closeConnection();
    await vi.waitFor(() => expect(exits).toEqual([1]), { timeout: 2_000 });
    expect(owner.tryCount).toBe(1);
  } finally {
    release?.();
    await inFlight;
    await locks.close();
  }
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
