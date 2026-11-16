import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import postgres from "postgres";

import { startPostgresTestContainer } from
  "../../../packages/db-schema/scripts/postgres-test-container.mjs";
export interface TestDatabaseLease {
  url: string;
  cleanup: () => Promise<void>;
}

export function hasTestDatabaseResource(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL?.trim())
    || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

export async function provisionTestDatabase({
  prefix,
  dockerUser,
  dockerPassword,
  dockerDatabase,
}: {
  prefix: string;
  dockerUser: string;
  dockerPassword: string;
  dockerDatabase: string;
}): Promise<TestDatabaseLease> {
  const external = process.env.TEST_DATABASE_URL?.trim();
  if (external) return await provisionExternalDatabase(external, prefix);
  return await provisionDockerDatabase({ dockerUser, dockerPassword, dockerDatabase });
}

function assertSafeTestUrl(value: string): URL {
  const url = new URL(value);
  const database = url.pathname.slice(1).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(database)
    || !database.includes("test")
    || ["atom_db", "reverie", "soulstream", "serendipity"].some((name) =>
      database.includes(name))) {
    throw new Error(`unsafe TEST_DATABASE_URL database name: ${database}`);
  }
  return url;
}

async function provisionExternalDatabase(value: string, prefix: string) {
  const base = assertSafeTestUrl(value);
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24);
  const database = `${base.pathname.slice(1)}_${safePrefix}_${process.pid}_`
    + randomUUID().replaceAll("-", "").slice(0, 12);
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, idle_timeout: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const databaseUrl = new URL(base);
  databaseUrl.pathname = `/${database}`;
  return {
    url: databaseUrl.toString(),
    cleanup: async () => await dropExternalTestDatabase(adminUrl, database),
  };
}

async function dropExternalTestDatabase(adminUrl: URL, database: string): Promise<void> {
  const cleanupSql = postgres(adminUrl.toString(), { max: 1, idle_timeout: 1 });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // 공유 시험 DB 서버에서는 비 superuser 역할이 다른 역할의 세션을 종료할
      // 수 없다(autovacuum 작업자 포함). 그래서 종료는 우리 역할의 세션에만
      // 하고, DROP은 남은 세션이 빠지기를 잠깐 기다렸다가 다시 시도한다.
      await cleanupSql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${database}
          AND pid <> pg_backend_pid()
          AND usename = current_user
      `;
      try {
        await cleanupSql.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "55006" || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } finally {
    await cleanupSql.end({ timeout: 5 });
  }
}

async function provisionDockerDatabase({
  dockerUser,
  dockerPassword,
  dockerDatabase,
}: {
  dockerUser: string;
  dockerPassword: string;
  dockerDatabase: string;
}) {
  const container = startPostgresTestContainer({
    user: dockerUser,
    password: dockerPassword,
    database: dockerDatabase,
  });
  const url = assertSafeTestUrl(
    `postgresql://${dockerUser}:${dockerPassword}@127.0.0.1:${container.port}/${dockerDatabase}`,
  ).toString();
  const sql = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 1 });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await sql`SELECT 1`;
      await sql.end({ timeout: 5 });
      return {
        url,
        cleanup: async () => container.stop(),
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await sql.end({ timeout: 5 });
  container.stop();
  throw lastError;
}
