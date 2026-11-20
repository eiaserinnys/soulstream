import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CLAUDE_CENTRAL_POOL_SETTING_KEY,
  createSqlClaudeCentralSettingsRepository,
  type ClaudeCentralSettingsRepository,
} from "../src/claude_central/settings_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim())
  || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres("central Claude settings repository (PostgreSQL)", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: ClaudeCentralSettingsRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = createSqlClaudeCentralSettingsRepository({
      resolveSql: async () => harness.sql as unknown as LivePostgresSql,
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await harness.sql`
      DELETE FROM system_settings WHERE setting_key = ${CLAUDE_CENTRAL_POOL_SETTING_KEY}
    `;
  });

  it("applies the patch when the row does not exist yet", async () => {
    await repository.merge({ default_receive: false, nodes: { "node-a": false } });

    await expect(repository.read()).resolves.toEqual({
      default_receive: false,
      nodes: { "node-a": false },
    });
  });

  it("keeps both node values when two updates overlap", async () => {
    await Promise.all([
      repository.merge({ nodes: { "node-a": false } }),
      repository.merge({ nodes: { "node-b": true } }),
    ]);

    await expect(repository.read()).resolves.toEqual({
      default_receive: true,
      nodes: { "node-a": false, "node-b": true },
    });
  });

  it("removes only the null key and leaves the other node values", async () => {
    await repository.merge({ nodes: { "node-a": false, "node-b": true } });

    await repository.merge({ nodes: { "node-a": null } });

    await expect(repository.read()).resolves.toEqual({
      default_receive: true,
      nodes: { "node-b": true },
    });
  });

  it("keeps default_receive when the patch does not mention it", async () => {
    await repository.merge({ default_receive: false });

    await repository.merge({ nodes: { "node-c": true } });

    await expect(repository.read()).resolves.toEqual({
      default_receive: false,
      nodes: { "node-c": true },
    });
  });
});
