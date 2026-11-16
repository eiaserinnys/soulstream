import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
export interface FullSchemaPostgresHarness { sql: ReturnType<typeof postgres>; cleanup(): Promise<void>; }

export async function createFullSchemaPostgresHarness(): Promise<FullSchemaPostgresHarness> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await assertSafeExternalDatabase(externalUrl);
    return await connect(externalUrl);
  }

  const container = startPostgresTestContainer({
    user: "board_yjs_seed_test",
    password: "board_yjs_seed_test",
    database: "board_yjs_seed_test_db",
  });
  try {
    return await connect(
      `postgres://board_yjs_seed_test:board_yjs_seed_test@127.0.0.1:${container.port}/board_yjs_seed_test_db`,
      container.stop,
    );
  } catch (error) {
    container.stop();
    throw error;
  }
}

async function connect(
  url: string,
  stopContainer?: () => void,
): Promise<FullSchemaPostgresHarness> {
  const schema = `board_yjs_seed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const bootstrap = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => {} });
  try {
    await waitForPostgres(bootstrap);
    await bootstrap.unsafe(`CREATE SCHEMA ${schema}`);
    await bootstrap.unsafe(`SET search_path TO ${schema}`);
    const schemaSql = readFileSync(fileURLToPath(
      new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
    ), "utf8");
    await bootstrap.unsafe(schemaSql);
  } catch (error) {
    await dropSchema(url, schema);
    throw error;
  } finally {
    await bootstrap.end({ timeout: 2 });
  }

  const sql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  try {
    await waitForPostgres(sql);
  } catch (error) {
    await sql.end({ timeout: 2 });
    await dropSchema(url, schema);
    throw error;
  }
  return {
    sql,
    async cleanup() {
      try {
        await sql.end({ timeout: 2 });
      } finally {
        await dropSchema(url, schema);
        stopContainer?.();
      }
    },
  };
}

async function assertSafeExternalDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();
  const target = `${parsed.hostname}/${name}`.toLowerCase();
  if (!name.includes("test")) {
    throw new Error("TEST_DATABASE_URL database name must include 'test'");
  }
  if (["atom_db", "reverie", "soulstream", "serendipity"].some(
    (protectedName) => target.includes(protectedName)
  )) {
    throw new Error("TEST_DATABASE_URL points at a protected database name");
  }
  const sql = postgres(url, { max: 1, idle_timeout: 1 });
  try {
    const rows = await sql<readonly { count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    `;
    if ((rows[0]?.count ?? 0) > 0) {
      throw new Error("TEST_DATABASE_URL must point at an empty test database");
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function waitForPostgres(sql: ReturnType<typeof postgres>): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await waitForPostgres(sql);
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}
