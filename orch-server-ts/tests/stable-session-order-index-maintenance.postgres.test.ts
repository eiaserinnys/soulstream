import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  StableSessionOrderIndexMaintenance,
  startStableSessionOrderIndexMaintenance,
} from "../src/runtime/stable_session_order_index_maintenance.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

type SqlCall = { readonly query: string };

function sqlDouble(resultFor?: (query: string) => unknown[]) {
  const calls: SqlCall[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    calls.push({ query });
    return Promise.resolve(resultFor?.(query) ?? []);
  }) as never;
  return { sql, calls };
}

describe("stable session order index maintenance", () => {
  it("ensures the stable order index from the orchestrator SQL owner", async () => {
    const { sql, calls } = sqlDouble();
    const maintenance = new StableSessionOrderIndexMaintenance({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await maintenance.ensure();

    expect(calls.map((call) => call.query)).toEqual([
      expect.stringContaining("FROM pg_class c"),
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_updated_at_session_id",
      ),
    ]);
  });

  it("drops an invalid concurrent index remnant before recreating it", async () => {
    const { sql, calls } = sqlDouble((query) =>
      query.includes("FROM pg_class c")
        ? [{ indisvalid: false, indisready: false }]
        : []);
    const maintenance = new StableSessionOrderIndexMaintenance({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await maintenance.ensure();

    expect(calls.map((call) => call.query)).toEqual([
      expect.stringContaining("FROM pg_class c"),
      expect.stringContaining("DROP INDEX CONCURRENTLY idx_sessions_updated_at_session_id"),
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_updated_at_session_id",
      ),
    ]);
  });

  it("logs background failure without terminating the orchestrator", async () => {
    const maintenance = { ensure: vi.fn().mockRejectedValue(new Error("index failed")) };
    const logger = { info: vi.fn(), error: vi.fn() };

    startStableSessionOrderIndexMaintenance(maintenance, logger);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Stable session order index ensure failed; continuing without index",
    );
  });
});

describe("stable session order index maintenance PostgreSQL integration", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
  }, 60_000);

  afterAll(async () => {
    await harness.cleanup();
  }, 15_000);

  it("creates a valid stable-order index in the orchestrator-owned schema", async () => {
    const maintenance = new StableSessionOrderIndexMaintenance({
      resolveSql: async () => harness.liveSql,
      close: vi.fn(),
    });

    await maintenance.ensure();

    const rows = await indexState();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ indisvalid: true, indisready: true });
    expect(rows[0]?.definition).toContain(
      "USING btree (updated_at DESC, session_id DESC)",
    );
  }, 30_000);

  it("drops an invalid concurrent-index remnant and recreates it", async () => {
    await harness.sql`DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_updated_at_session_id`;
    const duplicateUpdatedAt = new Date("2026-08-07T00:00:00Z");
    await harness.sql`
      INSERT INTO sessions (session_id, updated_at)
      VALUES ('invalid-a', ${duplicateUpdatedAt}), ('invalid-b', ${duplicateUpdatedAt})
    `;
    await expect(harness.sql`
      CREATE UNIQUE INDEX CONCURRENTLY idx_sessions_updated_at_session_id
      ON sessions (updated_at)
    `).rejects.toThrow();
    expect(await indexState()).toMatchObject([{ indisvalid: false }]);

    const maintenance = new StableSessionOrderIndexMaintenance({
      resolveSql: async () => harness.liveSql,
      close: vi.fn(),
    });
    await maintenance.ensure();

    expect(await indexState()).toMatchObject([{
      indisvalid: true,
      indisready: true,
    }]);
  }, 45_000);

  async function indexState(): Promise<Array<{
    indisvalid: boolean;
    indisready: boolean;
    definition: string;
  }>> {
    return await harness.sql`
      SELECT i.indisvalid, i.indisready, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass('idx_sessions_updated_at_session_id')
    `;
  }
});
