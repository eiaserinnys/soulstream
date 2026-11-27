import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveProductionApplication, loadOrchServerEnvironment } from "../src/index.js";
import type { LiveDbSqlResolver, LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";
import { OPERATING_SUMMARY_SETTINGS } from "./helpers/summary_settings.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function composeWith(localOverlay: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "summary-settings-seed-wiring-"));
  directories.push(dir);
  const configPath = join(dir, "turn-summary.yaml");
  await copyFile(fileURLToPath(new URL("../config/turn-summary.yaml", import.meta.url)), configPath);
  if (localOverlay !== undefined) await writeFile(join(dir, "turn-summary.local.yaml"), localOverlay, "utf8");

  const seededValues: unknown[] = [];
  const schemaQuery = vi.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("FROM schema_migrations")) {
      return [{ migration_id: "088_test_schema", checksum: "test-schema-checksum", ordinal: 88 }];
    }
    if (statement.includes("INSERT INTO system_settings") && args[0] === "summary_settings") {
      seededValues.push(args[1]);
      return [{ value: args[1] }];
    }
    if (statement.includes("FROM users")) {
      return [{ email: "dashboard@example.com", is_admin: true, allowed_folder_ids: [], created_at: new Date() }];
    }
    return [];
  });
  const sql = Object.assign(schemaQuery, {
    json: (value: unknown) => value,
    array: (values: readonly unknown[]) => values,
    begin: async <T>(callback: (transaction: LivePostgresSql) => Promise<T>) => await callback(sql),
  }) as unknown as LivePostgresSql;
  const sqlResolver: LiveDbSqlResolver = { resolveSql: vi.fn(async () => sql), close: vi.fn(async () => undefined) };
  const config = loadOrchServerEnvironment({
    HOST: "127.0.0.1",
    SOULSTREAM_PUBLIC_URL: "https://dashboard.example.test",
    DATABASE_URL: "postgres://unused@localhost/unused",
    ENVIRONMENT: "production",
    DASHBOARD_DIR: fileURLToPath(new URL("./fixtures/dashboard-build", import.meta.url)),
    CORS_ALLOWED_ORIGINS: "http://127.0.0.1",
    AUTH_BEARER_TOKEN: "production-service-token",
    GOOGLE_CLIENT_ID: "dashboard-google-client",
    JWT_SECRET: "production-jwt-secret",
    CLAUDE_OAUTH_CLIENT_ID: "test-client",
    CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
  });
  const warn = vi.fn();
  const application = await createLiveProductionApplication(
    config, { warn }, { modelCatalog: repositoryModelCatalog(), sqlResolver, turnSummaryConfigPath: configPath },
  );
  await application.app.close();
  await application.closeResources();
  return { seededValues, warn };
}

describe("summary settings first-run seed at startup", () => {
  it("seeds the order the previous chain ran when the config file has summaries on", async () => {
    const { seededValues, warn } = await composeWith("enabled: true\nmodel: gpt-5.6-luna\n");
    expect(seededValues).toEqual([OPERATING_SUMMARY_SETTINGS]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("seed summary settings"));
  });

  it("seeds nothing while the config file leaves summaries off", async () => {
    const { seededValues } = await composeWith(undefined);
    expect(seededValues).toEqual([]);
  });
});
