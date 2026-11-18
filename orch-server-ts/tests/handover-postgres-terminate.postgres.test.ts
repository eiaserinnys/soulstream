import { createServer, connect as connectSocket, type AddressInfo, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { expect, it, vi } from "vitest";
import { decidePostgresTests } from "../../packages/db-schema/scripts/postgres-test-policy.mjs";
import { HandoverGate } from "../src/runtime/handover_gate.js";
import { HandoverPostgres } from "../src/runtime/handover_postgres.js";
import { createPagePostgresHarness } from "./page/page_postgres_harness.js";

type Sql = ReturnType<typeof postgres>;

const postgresBackendAvailable = decidePostgresTests().backendAvailable;

async function lockPids(sql: Sql, applicationName: string): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`
    SELECT l.pid
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND l.objsubid = 2
      AND l.classid = 485 AND l.objid IN (1553, 1554)
      AND a.application_name = ${applicationName}
    ORDER BY l.pid`;
  return rows.map(row => row.pid);
}

function lockClientFactory(applicationName: string) {
  return (url: string, onclose: () => void, onnotify?: (payload: string) => void) => postgres(url, {
    max: 1, idle_timeout: 0, max_lifetime: null,
    connection: { application_name: applicationName },
    onclose,
    onnotify: onnotify && ((_channel: string, payload: string) => onnotify(payload)),
  } as Parameters<typeof postgres>[1]);
}

/** A TCP relay that can stop listening for a while, like the database restart window. */
function proxyTo(target: URL) {
  const host = target.hostname;
  const port = Number(target.port || 5432);
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();
  let server: Server | undefined;
  let boundPort = 0;

  const listen = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const created = createServer(client => {
        clients.add(client);
        const upstream = connectSocket(port, host);
        upstreams.add(upstream);
        const drop = () => {
          clients.delete(client);
          upstreams.delete(upstream);
          client.destroy();
          upstream.destroy();
        };
        client.on("error", drop);
        client.on("close", drop);
        upstream.on("error", drop);
        upstream.on("close", drop);
        client.pipe(upstream).pipe(client);
      });
      created.once("error", reject);
      created.listen(boundPort, "127.0.0.1", () => {
        boundPort = (created.address() as AddressInfo).port;
        server = created;
        resolve();
      });
    });
  };

  return {
    async start(): Promise<void> { if (!server) await listen(); },
    async stop(): Promise<void> {
      for (const client of clients) client.destroy();
      for (const upstream of upstreams) upstream.destroy();
      clients.clear();
      upstreams.clear();
      const current = server;
      server = undefined;
      if (current) await new Promise<void>(resolve => current.close(() => resolve()));
    },
    get port(): number { return boundPort; },
  };
}

function proxyUrl(databaseUrl: string, proxyPort: number): string {
  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(proxyPort);
  return url.toString();
}

it.skipIf(!postgresBackendAvailable)("reacquires the advisory locks after another backend terminates their connections", async () => {
  const harness = await createPagePostgresHarness();
  const gate = new HandoverGate();
  const exits: number[] = [];
  const received: string[] = [];
  const uncaught: unknown[] = [];
  const onUncaught = (error: Error) => { uncaught.push(error); };
  const applicationName = `card1604_lock_${process.pid}_${Date.now()}`;
  process.on("uncaughtExceptionMonitor", onUncaught);
  const locks = new HandoverPostgres(harness.databaseUrl, gate, {
    exit: code => { exits.push(code); },
    clientFactory: lockClientFactory(applicationName),
  });
  const admin = postgres(harness.databaseUrl, { max: 1, idle_timeout: 1, onnotice: () => {} });
  try {
    await locks.subscribe(message => { received.push(message); });
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();
    await expect(gate.run(async () => "open")).resolves.toBe("open");
    expect(await lockPids(admin, applicationName)).toHaveLength(2);

    const sessions = await admin<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity WHERE application_name = ${applicationName} AND pid <> pg_backend_pid()`;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const { pid } of sessions) await admin`SELECT pg_terminate_backend(${pid})`;

    await vi.waitFor(async () => {
      expect(await lockPids(admin, applicationName)).toHaveLength(2);
    }, { timeout: 30_000, interval: 250 });
    await vi.waitFor(async () => { await expect(gate.run(async () => "open")).resolves.toBe("open"); });
    expect(exits).toEqual([]);

    // The owner session carried the LISTEN; the notification arrives only after
    // recovery re-issued LISTEN on the reacquired session.
    await vi.waitFor(async () => {
      await admin`SELECT pg_notify('soulstream_orch_handover', 'peer:request')`;
      expect(received).toContain("request");
    }, { timeout: 30_000, interval: 500 });
    expect(uncaught).toEqual([]);
  } finally {
    process.removeListener("uncaughtExceptionMonitor", onUncaught);
    await locks.close();
    await admin.end({ timeout: 2 });
    await harness.cleanup();
  }
}, 120_000);

it.skipIf(!postgresBackendAvailable)("fails the next query on a terminated reserved connection instead of hanging", async () => {
  const harness = await createPagePostgresHarness();
  const uncaught: unknown[] = [];
  const onUncaught = (error: Error) => { uncaught.push(error); };
  process.on("uncaughtExceptionMonitor", onUncaught);
  let closed = 0;
  const sql = postgres(harness.databaseUrl, {
    max: 1, idle_timeout: 0, max_lifetime: null, onnotice: () => {}, onclose: () => { closed++; },
  });
  const admin = postgres(harness.databaseUrl, { max: 1, idle_timeout: 1, onnotice: () => {} });
  try {
    const reserved = await sql.reserve();
    const [row] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await admin`SELECT pg_terminate_backend(${row!.pid})`;
    await vi.waitFor(() => expect(closed).toBeGreaterThan(0), { timeout: 10_000, interval: 50 });

    // The socket is gone, so execute() must fail the query immediately. Without
    // the guard it is queued into sent/query and never answers. Verified once
    // against the pre-fix patch: this race returned "timeout" instead of the
    // connection error (see prefix-execute-hang.md next to the packet).
    const result = await Promise.race([
      reserved`SELECT 42 AS answer`.then(
        () => "resolved",
        (error: { code?: string }) => `rejected:${error.code}`,
      ),
      sleep(5_000).then(() => "timeout"),
    ]);
    expect(result).toBe("rejected:CONNECTION_CLOSED");
    expect(uncaught).toEqual([]);
  } finally {
    process.removeListener("uncaughtExceptionMonitor", onUncaught);
    await sql.end({ timeout: 2 }).catch(() => {});
    await admin.end({ timeout: 2 });
    await harness.cleanup();
  }
}, 60_000);

it.skipIf(!postgresBackendAvailable)("reacquires the locks through a database outage window and restores notifications", async () => {
  const harness = await createPagePostgresHarness();
  const proxy = proxyTo(new URL(harness.databaseUrl));
  await proxy.start();
  const gate = new HandoverGate();
  const exits: number[] = [];
  const received: string[] = [];
  const uncaught: unknown[] = [];
  const onUncaught = (error: Error) => { uncaught.push(error); };
  const applicationName = `card1604_outage_${process.pid}_${Date.now()}`;
  process.on("uncaughtExceptionMonitor", onUncaught);
  const locks = new HandoverPostgres(proxyUrl(harness.databaseUrl, proxy.port), gate, {
    exit: code => { exits.push(code); },
    clientFactory: lockClientFactory(applicationName),
  });
  const admin = postgres(harness.databaseUrl, { max: 1, idle_timeout: 1, onnotice: () => {} });
  try {
    await locks.subscribe(message => { received.push(message); });
    expect(await locks.tryOwner()).toBe(true);
    await locks.acquirePage();
    await expect(gate.run(async () => "open")).resolves.toBe("open");
    expect(await lockPids(admin, applicationName)).toHaveLength(2);

    const sessions = await admin<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity WHERE application_name = ${applicationName} AND pid <> pg_backend_pid()`;
    for (const { pid } of sessions) await admin`SELECT pg_terminate_backend(${pid})`;
    // Stop accepting database connections for a while, as in the incident.
    await proxy.stop();
    await sleep(2_000);
    await proxy.start();

    await vi.waitFor(async () => {
      expect(await lockPids(admin, applicationName)).toHaveLength(2);
    }, { timeout: 60_000, interval: 500 });
    await vi.waitFor(async () => {
      await expect(gate.run(async () => "open")).resolves.toBe("open");
    }, { timeout: 60_000, interval: 100 });
    expect(exits).toEqual([]);

    // The outage dropped the LISTEN session. Recovery re-issues LISTEN; each
    // NOTIFY must reach the callback exactly once (no duplicate listener).
    received.length = 0;
    const deadline = Date.now() + 30_000;
    while (received.length === 0 && Date.now() < deadline) {
      await admin`SELECT pg_notify('soulstream_orch_handover', 'peer:request')`;
      await sleep(250);
    }
    expect(received).toEqual(["request"]);
    await sleep(300);
    expect(received).toEqual(["request"]);
    expect(uncaught).toEqual([]);
  } finally {
    process.removeListener("uncaughtExceptionMonitor", onUncaught);
    await locks.close();
    await admin.end({ timeout: 2 });
    await proxy.stop();
    await harness.cleanup();
  }
}, 180_000);
