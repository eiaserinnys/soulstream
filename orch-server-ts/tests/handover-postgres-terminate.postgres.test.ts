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
    clientFactory: (url, onclose) => postgres(url, {
      max: 1, idle_timeout: 0, max_lifetime: null, connection: { application_name: applicationName }, onclose,
    }),
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
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    for (const { pid } of sessions) await admin`SELECT pg_terminate_backend(${pid})`;

    await vi.waitFor(async () => {
      expect(await lockPids(admin, applicationName)).toHaveLength(2);
    }, { timeout: 30_000, interval: 250 });
    await vi.waitFor(async () => { await expect(gate.run(async () => "open")).resolves.toBe("open"); });
    expect(exits).toEqual([]);

    // The LISTEN connection was terminated too; the notification arrives only
    // after postgres.js re-subscribed on its reconnected listener client.
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
