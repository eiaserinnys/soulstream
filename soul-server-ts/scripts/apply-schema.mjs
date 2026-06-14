#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import dotenv from "dotenv";
import postgres from "postgres";

const DOTENV_PATH = ".env.soul-server-ts";
const LOCK_NAMESPACE = 260529;
const LOCK_ID = 1410;

export function resolveSchemaPath(scriptUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(scriptUrl)), "../../packages/db-schema/sql/schema.sql");
}

export function readDatabaseUrl(env = process.env) {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be postgres:// or postgresql://");
  }
  return databaseUrl;
}

export async function applySchema({ env = process.env, cwd = process.cwd() } = {}) {
  dotenv.config({ path: resolve(cwd, DOTENV_PATH), override: true, processEnv: env });

  const databaseUrl = readDatabaseUrl(env);
  const schemaSql = await readFile(resolveSchemaPath(), "utf8");
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
  });

  let locked = false;
  try {
    await sql`SELECT pg_advisory_lock(${LOCK_NAMESPACE}, ${LOCK_ID})`;
    locked = true;
    await sql.unsafe(schemaSql);
  } finally {
    if (locked) {
      await sql`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}, ${LOCK_ID})`.catch(() => undefined);
    }
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  try {
    await applySchema();
    console.log("[apply-schema] schema applied");
  } catch {
    console.error("[apply-schema] failed");
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  await main();
}
