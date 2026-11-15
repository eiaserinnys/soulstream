import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";

export interface TimelinePostgresDatabase {
  sql: ReturnType<typeof postgres>;
  /** 임시 스키마를 쓰는 외부 DB의 접속 URL. 컨테이너를 띄운 경우에도 채운다. */
  url: string;
  /** 이 시험이 소유한 임시 스키마 이름. */
  schema: string;
  cleanup(): Promise<void>;
}

/**
 * 타임라인 시험용 PostgreSQL.
 *
 * TEST_DATABASE_URL이 있으면 그 DB 안에 이 시험만의 임시 스키마를 만들어 쓴다.
 * 저장소의 board_yjs·page harness와 같은 방식으로, 격리 상자처럼 docker가 막히고
 * 격리 런타임이 TEST_DATABASE_URL을 주는 환경에서도 같은 시험을 돌리기 위해서다.
 * 없으면 전용 컨테이너를 띄운다(CI 기본 경로).
 */
export async function openTimelinePostgresDatabase(options: {
  user: string;
  password: string;
  database: string;
}): Promise<TimelinePostgresDatabase> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    assertSafeExternalDatabase(externalUrl);
    return await connectWithSchema(externalUrl);
  }
  const container = startPostgresTestContainer(options);
  try {
    return await connectWithSchema(
      `postgres://${options.user}:${options.password}@127.0.0.1:${container.port}/${options.database}`,
      container.stop,
    );
  } catch (error) {
    container.stop();
    throw error;
  }
}

async function connectWithSchema(url: string, stopContainer?: () => void): Promise<TimelinePostgresDatabase> {
  const schema = `report_timeline_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const bootstrap = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => undefined });
  try {
    await waitForPostgres(bootstrap);
    await bootstrap.unsafe(`CREATE SCHEMA ${schema}`);
    await bootstrap.unsafe(`SET search_path TO ${schema}`);
    await bootstrap.unsafe(readFileSync(
      new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8",
    ));
  } catch (error) {
    await dropSchema(url, schema);
    stopContainer?.();
    throw error;
  } finally {
    await bootstrap.end({ timeout: 2 });
  }
  const sql = postgres(url, {
    max: 4, idle_timeout: 1, onnotice: () => undefined,
    connection: { search_path: schema },
  });
  try {
    await waitForPostgres(sql);
  } catch (error) {
    await sql.end({ timeout: 2 });
    await dropSchema(url, schema);
    stopContainer?.();
    throw error;
  }
  return {
    sql,
    url,
    schema,
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

function assertSafeExternalDatabase(url: string): void {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();
  const target = `${parsed.hostname}/${name}`.toLowerCase();
  if (!name.includes("test")) {
    throw new Error("TEST_DATABASE_URL database name must include 'test'");
  }
  if (["atom_db", "reverie", "soulstream", "serendipity"].some((token) => target.includes(token))) {
    throw new Error("TEST_DATABASE_URL points at a protected database name");
  }
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const cleanup = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await waitForPostgres(cleanup);
    await cleanup.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await cleanup.end({ timeout: 2 });
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
