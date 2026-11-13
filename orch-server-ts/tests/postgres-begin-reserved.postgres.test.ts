import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

const APPLICATION_NAME = "begin-reserved-test";

type ConnectionOptions = {
  host: string[];
  port: number[];
  user: string;
  pass: string;
  database: string;
  connection: { search_path?: string };
};

/**
 * postgres.js marks the connection that runs `sql.begin` as reserved through the
 * query's onexecute callback. execute() used to skip that callback whenever an
 * earlier `&&` operand was false (pipeline limit reached), so BEGIN completed on
 * an unmarked connection: UNSAFE_TRANSACTION, and the server-side transaction
 * stayed open on a connection returned to the pool.
 */
describe("postgres.js sql.begin on a saturated pool", () => {
  let harness: PagePostgresHarness;
  beforeAll(async () => {
    harness = await createPagePostgresHarness();
  }, 60_000);
  afterAll(async () => await harness?.cleanup());

  it("reserves the connection even when BEGIN is pipelined behind a busy query", async () => {
    const options = harness.sql.options as unknown as ConnectionOptions;
    const pool = postgres({
      host: options.host[0]!,
      port: options.port[0]!,
      user: options.user,
      pass: options.pass,
      database: options.database,
      max: 2,
      max_pipeline: 1,
      idle_timeout: 1,
      onnotice: () => {},
      connection: {
        ...(options.connection.search_path === undefined
          ? {}
          : { search_path: options.connection.search_path }),
        application_name: APPLICATION_NAME,
      },
      // max_pipeline is a runtime option that postgres.js 3.4.9 types omit.
    } as postgres.Options<{}>);
    try {
      // Open both connections, then keep both of them busy so BEGIN has to be
      // pipelined behind a running query (sent.length === max_pipeline).
      await Promise.all([pool`SELECT 1`, pool`SELECT 1`]);
      const busy = [pool`SELECT pg_sleep(0.5)`, pool`SELECT pg_sleep(0.5)`];

      const value = await pool.begin(async (transaction) => {
        const [row] = await transaction<Array<{ one: number }>>`SELECT 1 AS one`;
        return row?.one;
      });
      expect(value).toBe(1);
      await Promise.all(busy);

      const open = await harness.sql<Array<{ state: string }>>`
        SELECT state FROM pg_stat_activity
        WHERE application_name = ${APPLICATION_NAME}
          AND state LIKE 'idle in transaction%'
      `;
      expect(open).toEqual([]);
    } finally {
      await pool.end({ timeout: 2 });
    }
  }, 30_000);
});
