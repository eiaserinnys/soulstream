import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { ResolvedSoakConfig } from "./config.js";

const require = createRequire(new URL("../../../orch-server-ts/package.json", import.meta.url));
const postgres = require("postgres") as typeof import("postgres").default;

export function stagingDatabaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("staging database admin URL must use postgres protocol");
  }
  const adminDatabase = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (adminDatabase !== "postgres" && adminDatabase !== "template1") {
    throw new Error("staging database admin URL must target postgres or template1");
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function prepareStagingDatabase(
  config: ResolvedSoakConfig,
  adminUrl: string,
): Promise<{ created: boolean; databaseUrl: string; migrationMode: "fresh-install" | "verify" }> {
  const databaseUrl = stagingDatabaseUrl(adminUrl, config.databaseName);
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 5, idle_timeout: 1 });
  let created = false;
  try {
    const rows = await admin`
      SELECT 1 AS present FROM pg_database WHERE datname = ${config.databaseName}
    `;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${config.databaseName}"`);
      created = true;
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const objectCount = await countStagingObjects(databaseUrl);
  const migrationMode = objectCount === 0 ? "fresh-install" : "verify";
  await runMigration(config, databaseUrl, migrationMode);
  return { created, databaseUrl, migrationMode };
}

async function countStagingObjects(databaseUrl: string): Promise<number> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 1 });
  try {
    const rows = await sql`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
    return Number(rows[0]?.count ?? 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function runMigration(
  config: ResolvedSoakConfig,
  databaseUrl: string,
  mode: "fresh-install" | "verify",
): Promise<void> {
  const script = join(config.repositoryRoot, "packages", "db-schema", "scripts", "migrate.mjs");
  const releaseId = `staging-soak-${Date.now()}`;
  await runProcess(process.execPath, [script, mode], {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SOULSTREAM_RELEASE_ID: releaseId,
    HANIEL_SERVICE_CWD: config.paths.databaseRelease,
    HANIEL_BACKUP_DIR: join(config.paths.databaseRelease, releaseId),
  }, config.paths.root);
}

async function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `staging migration failed (code=${String(code)}, signal=${String(signal)}): ${redact(stderr)}`,
      ));
    });
  });
}

function redact(value: string): string {
  return value.replaceAll(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted DATABASE_URL]").slice(-4_000);
}
