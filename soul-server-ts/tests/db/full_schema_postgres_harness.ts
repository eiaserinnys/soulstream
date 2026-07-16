import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import type { SqlClient } from "../../src/db/session_db.js";

const TEST_DB_NAME = "container_browse_test_db";
const TEST_USER = "container_browse_test";
const TEST_PASSWORD = "container_browse_test";

export interface FullSchemaPostgresHarness {
  sql: SqlClient;
  cleanup(): Promise<void>;
}

export const hasFullSchemaPostgresBackend =
  Boolean(process.env.TEST_DATABASE_URL?.trim())
  || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;

export async function createFullSchemaPostgresHarness(): Promise<FullSchemaPostgresHarness> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await assertSafeExternalDatabase(externalUrl);
    return await connect(externalUrl, undefined);
  }

  const containerId = execFileSync("docker", [
    "run",
    "--rm",
    "-d",
    "-e",
    `POSTGRES_USER=${TEST_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${TEST_DB_NAME}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ], { encoding: "utf8" }).trim();

  try {
    return await connect(
      `postgres://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${dockerPort(containerId)}/${TEST_DB_NAME}`,
      containerId,
    );
  } catch (err) {
    stopDocker(containerId);
    throw err;
  }
}

async function connect(
  url: string,
  containerId: string | undefined,
): Promise<FullSchemaPostgresHarness> {
  const schema = `container_browse_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const sql = postgres(url, { max: 1, idle_timeout: 1 }) as SqlClient;
  await waitForPostgres(sql);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  const schemaSql = readFileSync(
    fileURLToPath(new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url)),
    "utf8",
  );
  await sql.unsafe(schemaSql);
  return {
    sql,
    async cleanup() {
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await sql.end({ timeout: 5 });
        if (containerId) stopDocker(containerId);
      }
    },
  };
}

async function assertSafeExternalDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();
  const full = `${parsed.hostname}/${name}`.toLowerCase();
  if (!name.includes("test")) {
    throw new Error("TEST_DATABASE_URL database name must include 'test'");
  }
  if (["atom_db", "reverie", "soulstream", "serendipity"].some((word) => full.includes(word))) {
    throw new Error("TEST_DATABASE_URL points at a protected database name");
  }
  const sql = postgres(url, { max: 1, idle_timeout: 1 }) as SqlClient;
  try {
    const rows = await sql<Array<{ count: string | number }>>`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    `;
    if (Number(rows[0]?.count ?? 0) > 0) {
      throw new Error("TEST_DATABASE_URL must point at an empty test database");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function waitForPostgres(sql: SqlClient): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function dockerPort(containerId: string): string {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const output = execFileSync("docker", ["port", containerId, "5432/tcp"], {
      encoding: "utf8",
    }).trim();
    const match = output.match(/:(\d+)$/);
    if (match) return match[1];
  }
  throw new Error("docker did not publish a PostgreSQL port");
}

function stopDocker(containerId: string): void {
  execFileSync("docker", ["stop", containerId], { stdio: "ignore" });
}
