import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { TEST_SCHEMA_PATTERN } from "../../packages/db-schema/scripts/postgres-test-policy.mjs";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";

export interface IsolatedPostgresOptions {
  /** 시험 풀의 최대 연결 수. */
  max?: number;
  /** 풀의 모든 연결에 거는 서버 설정(예: statement_timeout). search_path는 harness가 정한다. */
  connection?: Record<string, string | number>;
}

export interface IsolatedPostgres {
  /** search_path가 이 시험의 스키마인 풀. */
  sql: ReturnType<typeof postgres>;
  /** 새 연결도 같은 스키마를 보게 하는 접속 URL(`options=-csearch_path`). */
  url: string;
  /** 이 시험이 소유한 임시 스키마 이름. */
  schema: string;
  cleanup(): Promise<void>;
}

const CONTAINER_LOGIN = { user: "isolated_test", password: "isolated_test", database: "isolated_test_db" };
const SCHEMA_SQL_URL = new URL("../../packages/db-schema/sql/schema.sql", import.meta.url);

/**
 * schema.sql을 적용한 시험 전용 스키마를 가진 PostgreSQL.
 *
 * TEST_DATABASE_URL이 있으면 그 DB 안에 임시 스키마를 만들고, 없으면 전용 컨테이너를 띄운다(CI 기본 경로).
 */
export async function openIsolatedPostgres(options: IsolatedPostgresOptions = {}): Promise<IsolatedPostgres> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await assertSafeExternalDatabase(externalUrl);
    return await connectWithSchema(externalUrl, options);
  }
  const container = startPostgresTestContainer(CONTAINER_LOGIN);
  try {
    const { user, password, database } = CONTAINER_LOGIN;
    return await connectWithSchema(
      `postgres://${user}:${password}@127.0.0.1:${container.port}/${database}`,
      options,
      container.stop,
    );
  } catch (error) {
    container.stop();
    throw error;
  }
}

async function connectWithSchema(
  baseUrl: string,
  options: IsolatedPostgresOptions,
  stopContainer?: () => void,
): Promise<IsolatedPostgres> {
  const schema = `isolated_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const bootstrap = postgres(baseUrl, { max: 1, idle_timeout: 1, onnotice: () => undefined });
  try {
    await waitForPostgres(bootstrap);
    await bootstrap.unsafe(`CREATE SCHEMA ${schema}`);
    await bootstrap.unsafe(`SET search_path TO ${schema}`);
    await bootstrap.unsafe(readFileSync(fileURLToPath(SCHEMA_SQL_URL), "utf8"));
  } catch (error) {
    await dropSchema(baseUrl, schema);
    throw error;
  } finally {
    await bootstrap.end({ timeout: 2 });
  }

  const scopedUrl = new URL(baseUrl);
  scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
  const sql = postgres(baseUrl, {
    max: options.max,
    onnotice: () => undefined,
    connection: { ...options.connection, search_path: schema },
  });
  try {
    await waitForPostgres(sql);
  } catch (error) {
    await sql.end({ timeout: 2 });
    await dropSchema(baseUrl, schema);
    throw error;
  }
  return {
    sql,
    url: scopedUrl.toString(),
    schema,
    async cleanup() {
      try {
        await sql.end({ timeout: 2 });
      } finally {
        try {
          await dropSchema(baseUrl, schema);
        } finally {
          stopContainer?.();
        }
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
  if (["atom_db", "reverie", "soulstream", "serendipity"].some((protectedName) => target.includes(protectedName))) {
    throw new Error("TEST_DATABASE_URL points at a protected database name");
  }
  const sql = postgres(url, { max: 1, idle_timeout: 1 });
  try {
    const rows = await sql<readonly { count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        AND table_schema !~ ${TEST_SCHEMA_PATTERN}
    `;
    if ((rows[0]?.count ?? 0) > 0) {
      throw new Error("TEST_DATABASE_URL must point at an empty test database");
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await waitForPostgres(sql);
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
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
