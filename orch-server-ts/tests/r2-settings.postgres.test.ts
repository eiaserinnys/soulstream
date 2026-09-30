import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { readR2Settings, updateR2Settings } from "../src/system/r2_settings.js";
// Existing operations scripts are JavaScript and have no declaration file.
// @ts-expect-error JavaScript operations boundary
import { importBoardR2, boardR2Status } from "../../packages/db-schema/scripts/import-board-r2.mjs";
let h: PagePostgresHarness;
const fields = { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "private-files", accessKeyId: "db-access", secretAccessKey: "db-secret" };
const env = { R2_BOARD_ASSETS_ENDPOINT: fields.endpoint, R2_BOARD_ASSETS_BUCKET: fields.bucket, R2_BOARD_ASSETS_ACCESS_KEY_ID: fields.accessKeyId, R2_BOARD_ASSETS_SECRET_ACCESS_KEY: fields.secretAccessKey };
beforeAll(async () => {
  // This test only starts a new disposable container; never use an existing database.
  if (process.env.TEST_DATABASE_URL) throw new Error("Use a fresh test container for R2 operations tests");
  h = await createPagePostgresHarness();
  const schema = readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
  const ddl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS system_settings ("), schema.indexOf("INSERT INTO system_settings (setting_key, value, version, updated_by)"));
  await h.sql.unsafe(ddl);
  const count = await h.sql`SELECT COUNT(*) AS count FROM system_settings`;
  expect(Number(count[0]!.count)).toBe(0);
}, 60_000);
afterAll(async () => { await h?.cleanup(); });
it("imports before the migration, preserves existing values, and verifies SQL secret CAS", async () => {
  expect(await importBoardR2(h.sql, env)).toMatchObject({ imported: true, version: 1 });
  const migration = readFileSync(new URL("../../packages/db-schema/sql/migrations/111_r2_storage_settings.sql", import.meta.url), "utf8");
  await h.sql.unsafe(migration);
  expect((await readR2Settings(h.sql, "board")).secretAccessKey).toBe(fields.secretAccessKey);
  await expect(importBoardR2(h.sql, { ...env, R2_BOARD_ASSETS_SECRET_ACCESS_KEY: "overwrite" })).rejects.toThrow("without overwriting");
  const saved = await updateR2Settings(h.sql, "board", { ...fields, secretAccessKey: undefined, accessKeyId: "changed", expectedVersion: 1, updatedBy: "admin@example.com" });
  expect(saved).toMatchObject({ accessKeyId: "changed", secretAccessKey: fields.secretAccessKey, version: 2 });
  await expect(updateR2Settings(h.sql, "board", { ...fields, expectedVersion: 1, updatedBy: "admin@example.com" })).rejects.toMatchObject({ statusCode: 409 });
  expect((await updateR2Settings(h.sql, "board", { ...fields, secretAccessKey: "new-secret", expectedVersion: 2, updatedBy: "admin@example.com" })).secretAccessKey).toBe("new-secret");
  expect((await updateR2Settings(h.sql, "board", { ...fields, secretAccessKey: "", expectedVersion: 3, updatedBy: "admin@example.com" })).secretAccessKey).toBe("");
  const status = await boardR2Status(h.sql); expect(status).toMatchObject({ secret_access_key_configured: false }); expect(JSON.stringify(status)).not.toContain("db-secret");
  expect((await readR2Settings(h.sql, "attachment")).endpoint).toBe("");
  // Partially configured settings also cannot be replaced by the import.
  await expect(importBoardR2(h.sql, env)).rejects.toThrow("without overwriting");
  await h.sql`DELETE FROM system_settings WHERE setting_key = 'board_r2'`;
  await h.sql.unsafe(migration);
  expect(await importBoardR2(h.sql, env)).toMatchObject({ imported: true, version: 2 });
}, 60_000);
